// 规则测试（B1-12y 第 2 次，spec-test r1 两条 S1；BR-TEXT-20 细则「短信渠道登记与后台渠道开关」；
// 编排裁定 D10-316 ①）：从 app.module 取真实装配，检查按编码取登记与站长告警真实通道确实接上了。
// - 不起 Nest、不 listen：调用 AppModule.forEntry，截下它交给模块构造器的 provider / 工厂。
//   api 入口取交给 IdentityModule.forRoot 的 smsSender，admin 入口取交给 AdminAuthModule.forRoot
//   的 smsSender，按 provider 自己的 inject 清单给值（APP_CONFIG、ROOT_LOGGER、CLOCK、DB = 测试库；
//   其余可选 token 不提供）后调用；worker 入口取交给 UnionAuthModule.forWorker 的 alerts 工厂，按
//   union 给的依赖（db、clock、logger、appEnv）调用，得到站长告警 port。
// - 传输层：app.module 的生产传输层调全局 fetch，这里换成记录请求、按脚本应答的替身，不出网。
// - 配置：loadConfig 的 test 配置换上 appEnv 与 SMS 配置（手工构造；凭据、签名、模板 CODE 都是
//   明显的假值，登记值与部署配置值互不相同）。
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  SiteAuthAlertPlan,
  SiteAuthAlertPort,
  VerifyCodeSmsSender,
} from '../../../../apps/api/src/modules/notification/index.ts';
import type { AliyunSmsFetchInit } from '../../../../apps/api/src/modules/notification/sms/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB as DB_TOKEN,
  FixedClock,
  ROOT_LOGGER,
  loadConfig,
  type AppConfig,
  type Clock,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { databaseFixture } from '../../linking/open-pdd-auth/database.ts';
import { memoryLogger } from '../../platform/queue/kit.ts';
import {
  ALERT_REG,
  AT,
  CONFIG,
  VERIFY_REG,
  fullText,
  lowerHeaders,
  newAppId,
  recomputedAuthorization,
  requestView,
  seedTemplate,
  seedUnionAccount,
  type SentRequest,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const EXPIRES_ISO = '2026-11-07T16:00:00.000Z';
const ALERT_PARAMS = { platform_name: '淘宝', expires_at: '2026-11-08 00:00' };

type AppEnv = AppConfig['appEnv'];

interface ScriptedReply {
  readonly status: number;
  readonly body: string;
}

function okReply(bizId: string): ScriptedReply {
  return {
    status: 200,
    body: JSON.stringify({ Code: 'OK', Message: 'OK', BizId: bizId, RequestId: `req-${bizId}` }),
  };
}

/** 全局 fetch 的替身：记录每个请求，按脚本应答；脚本用完再调用就抛错。 */
function globalWire(replies: readonly ScriptedReply[]) {
  const calls: SentRequest[] = [];
  const fetch = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as AliyunSmsFetchInit });
    const reply = replies[calls.length - 1];
    if (reply === undefined) throw new Error('unscripted synthetic request');
    return new Response(reply.body, { status: reply.status });
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, fetch };
}

/** 手工构造的 AppConfig：test 配置换上 appEnv，SMS 配置四项齐。 */
function configFor(appEnv: AppEnv): AppConfig {
  return { ...loadConfig({ APP_ENV: 'test' }), appEnv, sms: CONFIG };
}

interface CapturedProvider {
  readonly inject?: readonly unknown[];
  readonly useFactory: (...args: unknown[]) => unknown;
}

type ModuleBuilder = Record<string, (options: Record<string, unknown>) => unknown>;

const API_SRC = '../../../../apps/api/src/';

async function moduleExport(path: string, name: string): Promise<ModuleBuilder> {
  // URL imports keep parameter decorators in API controllers out of test's erasable TS project.
  const loaded = (await import(new URL(`${API_SRC}${path}`, import.meta.url).href)) as Record<
    string,
    ModuleBuilder
  >;
  const value = loaded[name];
  if (value === undefined) throw new Error(`wiring: ${path} does not export ${name}`);
  return value;
}

/**
 * 调用 AppModule.forEntry（真实装配），返回 builder[method] 收到的每份 options；只截取，照常调用原方法。
 */
async function capturedOptions(
  entry: 'api' | 'admin' | 'worker',
  config: AppConfig,
  db: Kysely<DB>,
  clock: Clock,
  logger: RootLogger,
  builder: ModuleBuilder,
  method: string,
): Promise<Record<string, unknown>[]> {
  const appModule = await moduleExport('app.module.ts', 'AppModule');
  const forEntry = appModule['forEntry'];
  if (forEntry === undefined) throw new Error('wiring: AppModule.forEntry is missing');
  const spy = vi.spyOn(builder, method);
  try {
    forEntry.call(appModule, {
      entry,
      config,
      clock,
      logger,
      dbHandles: { db, dbRead: null, close: async () => undefined },
    });
    return spy.mock.calls.map(([options]) => options);
  } finally {
    spy.mockRestore();
  }
}

/** 按 provider 的 inject 清单给值后调用它的 useFactory（必需的 token 没有值就报错）。 */
async function resolveProvider(
  provider: CapturedProvider,
  values: ReadonlyMap<unknown, unknown>,
): Promise<unknown> {
  const args = (provider.inject ?? []).map((item) => {
    const described = typeof item === 'object' && item !== null && 'token' in item;
    const token = described ? (item as { token: unknown }).token : item;
    if (values.has(token)) return values.get(token);
    if (described && (item as { optional?: boolean }).optional === true) return undefined;
    throw new Error(`wiring: no value for the required token ${String(token)}`);
  });
  return await provider.useFactory(...args);
}

/** app.module 交给 api（identity）或 admin（AdminAuthModule）入口的 SmsSender，按其 inject 组装。 */
async function assembledSmsSender(
  entry: 'api' | 'admin',
  appEnv: AppEnv,
  db: Kysely<DB>,
): Promise<VerifyCodeSmsSender> {
  const config = configFor(appEnv);
  const clock = new FixedClock(AT);
  const { logger } = memoryLogger(entry);
  const builder =
    entry === 'api'
      ? await moduleExport('modules/identity/index.ts', 'IdentityModule')
      : await moduleExport('modules/admin/index.ts', 'AdminAuthModule');
  const options = await capturedOptions(entry, config, db, clock, logger, builder, 'forRoot');
  const providers = options
    .map((option) => option['smsSender'] as CapturedProvider | undefined)
    .filter((provider): provider is CapturedProvider => provider !== undefined);
  expect(providers, `${entry} 入口应恰有一个 smsSender provider`).toHaveLength(1);
  const values = new Map<unknown, unknown>([
    [APP_CONFIG, config],
    [ROOT_LOGGER, logger],
    [CLOCK, clock],
    [DB_TOKEN, db],
  ]);
  return (await resolveProvider(providers[0]!, values)) as VerifyCodeSmsSender;
}

type AlertsFactory = (deps: {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly appEnv: AppEnv;
}) => unknown;

/** app.module 交给 worker 的 UnionAuthModule.forWorker 的 alerts 工厂，按 union 给的依赖调用。 */
async function assembledAlerts(
  appEnv: AppEnv,
  db: Kysely<DB>,
  clock: Clock,
  logger: RootLogger,
): Promise<SiteAuthAlertPort> {
  const builder = await moduleExport('modules/union/index.ts', 'UnionAuthModule');
  const options = await capturedOptions(
    'worker',
    configFor(appEnv),
    db,
    clock,
    logger,
    builder,
    'forWorker',
  );
  expect(options, 'worker 入口应恰装配一次 UnionAuthModule').toHaveLength(1);
  const alerts = options[0]!['alerts'] as AlertsFactory;
  return alerts({ db, clock, logger, appEnv }) as SiteAuthAlertPort;
}

function verifyRequest(app_id: string) {
  return { app_id, phone: '13912345678', purpose: 'login' as const, code: '042019' };
}

it.each([
  ['api', 'staging'],
  ['api', 'prod'],
  ['admin', 'staging'],
  ['admin', 'prod'],
] as const)(
  '[AC-B1-12y#21] 装配：%s 入口（%s，SMS 配置齐）的 SmsSender 发码时，有 SMS_CODE 在用登记的 app 的 SendSms 用登记的 SignName / TemplateCode，没有登记的 app 用部署配置；凭据都是部署配置',
  async (entry, appEnv) => {
    const db = database();
    const registered = newAppId('wiring-sms');
    const unregistered = newAppId('wiring-sms');
    await seedTemplate(db, {
      appId: registered,
      code: 'SMS_CODE',
      channels: ['sms'],
      active: VERIFY_REG,
    });
    const wire = globalWire([okReply('biz-wiring-1'), okReply('biz-wiring-2')]);
    const sender = await assembledSmsSender(entry, appEnv, db);
    const first = await sender.send(verifyRequest(registered));
    const second = await sender.send(verifyRequest(unregistered));
    expect({ first, second, calls: wire.calls.length }).toEqual({
      first: 'accepted',
      second: 'accepted',
      calls: 2,
    });
    const sent = wire.calls.map((call) => {
      const view = requestView(call);
      const params = view.query.params;
      return [
        view.action,
        params['PhoneNumbers'],
        params['SignName'],
        params['TemplateCode'],
        params['TemplateParam'],
      ];
    });
    expect(sent).toEqual([
      ['SendSms', '13912345678', VERIFY_REG.signName, VERIFY_REG.templateCode, '{"code":"042019"}'],
      ['SendSms', '13912345678', CONFIG.signName, CONFIG.verifyCodeTemplate, '{"code":"042019"}'],
    ]);
    for (const call of wire.calls) {
      expect(lowerHeaders(call.init.headers)['authorization']).toBe(
        recomputedAuthorization(call, {
          accessKeyId: CONFIG.accessKeyId,
          accessKeySecret: CONFIG.accessKeySecret,
        }),
      );
    }
    expect(fullText(wire.calls)).not.toContain(CONFIG.accessKeySecret);
  },
);

/** 一个联盟账号、UNION_AUTH_EXPIRING 的在用登记、一个号码：经 port 计划并投递一条 d14 告警。 */
async function alertScenario(
  db: Kysely<DB>,
  port: SiteAuthAlertPort,
): Promise<{ readonly appId: string }> {
  const appId = newAppId('wiring-alert');
  const unionAccountId = randomUUID();
  await seedUnionAccount(db, { appId, id: unionAccountId, expiresAt: new Date(EXPIRES_ISO) });
  await seedTemplate(db, {
    appId,
    code: 'UNION_AUTH_EXPIRING',
    channels: ['sms'],
    active: ALERT_REG,
  });
  const plan: SiteAuthAlertPlan = {
    appId,
    unionAccountId,
    platform: 'taobao',
    authExpiresAt: new Date(EXPIRES_ISO),
    stage: 'd14',
    code: 'UNION_AUTH_EXPIRING',
    phoneIds: ['phone-a'],
  };
  await db.transaction().execute((trx) => port.plan(trx, plan));
  await port.deliver(appId, unionAccountId, [{ phoneId: 'phone-a', phone: '13800138000' }]);
  return { appId };
}

function alertRows(db: Kysely<DB>, appId: string) {
  return db
    .selectFrom('notify_logs')
    .select(['dedupe_key', 'channel', 'status', 'sms_biz_id'])
    .where('app_id', '=', appId)
    .execute();
}

it.each([
  ['staging', 'local'],
  ['prod', 'test'],
] as const)(
  '[AC-B1-12y#22] 装配：worker 的站长告警 port 在 %s（SMS 配置齐）走真实通道：计划中的告警发出一次 SendSms（登记的签名与模板 CODE、OutId = 去重键），受理后该行 success 且 sms_biz_id = BizId；同样装配在 %s 仍是假发送器（不发请求、不写 BizId）',
  async (liveEnv, fakeEnv) => {
    const db = database();
    const clock = new FixedClock(AT);
    const { logger } = memoryLogger('worker');
    const wire = globalWire([okReply('biz-wiring-alert')]);

    const live = await assembledAlerts(liveEnv, db, clock, logger);
    const { appId } = await alertScenario(db, live);
    expect(wire.calls).toHaveLength(1);
    const sent = wire.calls[0];
    expect(sent).toBeDefined();
    if (sent === undefined) return;
    const view = requestView(sent);
    const rows = await alertRows(db, appId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect({
      action: view.action,
      params: view.query.params,
    }).toEqual({
      action: 'SendSms',
      params: {
        PhoneNumbers: '13800138000',
        SignName: ALERT_REG.signName,
        TemplateCode: ALERT_REG.templateCode,
        TemplateParam: JSON.stringify(ALERT_PARAMS),
        OutId: row?.dedupe_key,
      },
    });
    expect(row).toEqual({
      dedupe_key: expect.any(String),
      channel: 'sms',
      status: 'success',
      sms_biz_id: 'biz-wiring-alert',
    });
    expect(lowerHeaders(sent.init.headers)['authorization']).toBe(
      recomputedAuthorization(sent, {
        accessKeyId: CONFIG.accessKeyId,
        accessKeySecret: CONFIG.accessKeySecret,
      }),
    );
    expect(fullText(wire.calls)).not.toContain(CONFIG.accessKeySecret);

    const fake = await assembledAlerts(fakeEnv, db, clock, logger);
    const local = await alertScenario(db, fake);
    expect(wire.calls).toHaveLength(1);
    expect(await alertRows(db, local.appId)).toEqual([
      { dedupe_key: expect.any(String), channel: 'sms', status: 'success', sms_biz_id: null },
    ]);
  },
);
