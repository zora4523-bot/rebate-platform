// 规则测试（B1-12y；BR-TEXT-20 站长告警短信与细则「短信渠道登记与后台渠道开关」；BR-ID-24；04 §3.2
// notify_logs.sms_biz_id；编排裁定 D10-316 ①）：createLiveTemplateSmsSender 实现 site-auth-alert 的
// TemplateSmsSender，走阿里云 SendSms 真实通道（假 fetch）。
// - 签名与模板 CODE 来自登记（resolver，按 appId + 模板编码），AccessKey 来自部署配置；OutId = outId。
// - 受理 → accepted，BizId 写进 app_id + dedupe_key = outId 且 channel = 'sms' 那一行的 sms_biz_id，
//   该行的 status / sent_at / row_version 不动（站长告警端口自己收尾）。
// - 未登记或明确拒收 → rejected；超时、通道失败 → unknown；都只发一次、不写 BizId；send 不抛错。
// - 与 createSiteAuthAlertPort 接起来：受理的行 success 且 sms_biz_id 落在对应行；未登记的行 failed。
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import {
  createLiveTemplateSmsSender,
  createRegisteredTemplateResolver,
  createSiteAuthAlertPort,
  type RegisteredTemplateResolver,
  type SiteAuthAlertPlan,
  type TemplateSmsMessage,
} from '../../../../apps/api/src/modules/notification/index.ts';
import type { AliyunSmsTemplate } from '../../../../apps/api/src/modules/notification/sms/index.ts';
import {
  FixedClock,
  createResilienceRegistry,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { databaseFixture } from '../../linking/open-pdd-auth/database.ts';
import { memoryLogger } from '../../platform/queue/kit.ts';
import {
  ALERT_REG,
  AT,
  CONFIG,
  DEPLOY,
  ManualScheduler,
  OK_REPLY,
  PENDING_REG,
  fullText,
  json,
  lowerHeaders,
  logRow,
  newAppId,
  observe,
  recomputedAuthorization,
  requestView,
  seedClaimedLog,
  seedTemplate,
  seedUnionAccount,
  templateOf,
  transport,
  until,
  type Reply,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

const EXPIRES_ISO = '2026-11-07T16:00:00.000Z';
const ALERT_PARAMS = { platform_name: '淘宝', expires_at: '2026-11-08 00:00' };

function okReply(bizId: string): Reply {
  return json(200, { Code: 'OK', Message: 'OK', BizId: bizId, RequestId: `req-${bizId}` });
}

/** 内存里的 resolver：按模板编码给出登记，记录每次查询。 */
function memoryResolver(table: Readonly<Record<string, AliyunSmsTemplate>>) {
  const resolve = vi.fn<RegisteredTemplateResolver['resolve']>(async (query) =>
    Object.hasOwn(table, query.code) ? table[query.code] : undefined,
  );
  return { resolve };
}

/** 每个用例自己构造（骨架在构造时就抛 NotImplemented）。 */
function live(db: Kysely<DB>, replies: readonly Reply[], resolver: RegisteredTemplateResolver) {
  const scheduler = new ManualScheduler();
  const registry = createResilienceRegistry();
  const wire = transport(replies);
  let nonces = 0;
  let ids = 0;
  const sender = createLiveTemplateSmsSender({
    sms: CONFIG,
    resolver,
    db,
    registry,
    scheduler,
    fetch: wire.fetch,
    clock: new FixedClock(AT),
    nonce: () => `sms-nonce-${String(++nonces)}`,
    messageId: () => `tpl-msg-${String(++ids)}`,
  });
  return { ...wire, scheduler, registry, sender };
}

function alertKey(stage = 'd14', phoneId = 'phone-a'): string {
  return `union_auth:${randomUUID()}:${EXPIRES_ISO}:${stage}:${phoneId}`;
}

function alertMessage(appId: string, outId: string): TemplateSmsMessage {
  return {
    appId,
    phone: '13800138000',
    template: 'UNION_AUTH_EXPIRING',
    params: { ...ALERT_PARAMS },
    outId,
  };
}

it('[AC-B1-12y#8] 受理：一次 SendSms，SignName / TemplateCode 来自 notify_templates 的在用登记（不是部署配置），凭据来自部署配置，OutId = outId；BizId 写进对应行，该行状态不动', async () => {
  const db = database();
  const appId = newAppId('live-sms');
  const { logger } = memoryLogger('worker');
  await seedTemplate(db, {
    appId,
    code: 'UNION_AUTH_EXPIRING',
    channels: ['sms'],
    active: ALERT_REG,
  });
  const outId = alertKey();
  await seedClaimedLog(db, { appId, dedupeKey: outId });
  const resolver = createRegisteredTemplateResolver({ db, logger, deployVerifyCode: DEPLOY });
  const r = live(db, [OK_REPLY, OK_REPLY], resolver);
  const result = await r.sender.send(alertMessage(appId, outId));
  expect({ result, calls: r.calls.length }).toEqual({ result: 'accepted', calls: 1 });
  const sent = r.calls[0];
  expect(sent).toBeDefined();
  if (sent === undefined) return;
  const view = requestView(sent);
  const request = { method: view.method, body: view.body, action: view.action, query: view.query };
  expect(request).toEqual({
    method: 'POST',
    body: '',
    action: 'SendSms',
    query: {
      params: {
        PhoneNumbers: '13800138000',
        SignName: ALERT_REG.signName,
        TemplateCode: ALERT_REG.templateCode,
        TemplateParam: JSON.stringify(ALERT_PARAMS),
        OutId: outId,
      },
      count: 5,
    },
  });
  expect(lowerHeaders(sent.init.headers)['authorization']).toBe(
    recomputedAuthorization(sent, {
      accessKeyId: CONFIG.accessKeyId,
      accessKeySecret: CONFIG.accessKeySecret,
    }),
  );
  expect(await logRow(db, appId, outId)).toEqual({
    channel: 'sms',
    status: 'failed',
    sent_at: null,
    row_version: 1,
    sms_biz_id: 'biz-synthetic-1',
  });
  expect(r.unexpectedFetch).not.toHaveBeenCalled();
  expect(fullText(r.calls)).not.toContain(CONFIG.accessKeySecret);
});

it('[AC-B1-12y#9] 未登记（resolver 给 undefined）→ rejected，不发请求，不写 BizId；resolver 按 appId 与模板编码查', async () => {
  const db = database();
  const appId = newAppId('live-sms');
  const outId = alertKey('expired');
  await seedClaimedLog(db, { appId, dedupeKey: outId, code: 'UNION_AUTH_EXPIRED' });
  const resolver = memoryResolver({ UNION_AUTH_EXPIRING: templateOf(ALERT_REG) });
  const r = live(db, [OK_REPLY], resolver);
  const result = await r.sender.send({
    appId,
    phone: '13800138000',
    template: 'UNION_AUTH_EXPIRED',
    params: { platform_name: '淘宝' },
    outId,
  });
  expect({ result, calls: r.calls.length }).toEqual({ result: 'rejected', calls: 0 });
  expect(resolver.resolve).toHaveBeenCalled();
  for (const [query] of resolver.resolve.mock.calls) {
    expect(query).toMatchObject({ appId, code: 'UNION_AUTH_EXPIRED' });
    expect([undefined, 'default']).toContain(query.variant);
  }
  expect((await logRow(db, appId, outId)).sms_biz_id).toBeNull();
  expect(r.unexpectedFetch).not.toHaveBeenCalled();
});

it.each([
  ['供应商明确拒收', 'rejected', json(200, { Code: 'isv.MOBILE_NUMBER_ILLEGAL', Message: 'x' })],
  ['HTTP 503', 'unknown', json(503, { Code: 'ServiceUnavailable', Message: 'x' })],
  ['fetch 抛错', 'unknown', 'throw'],
] as [string, 'rejected' | 'unknown', Reply][])(
  '[AC-B1-12y#10] 未受理不写 BizId：%s → %s，只发一次请求（不登记备用、不重发），send 不抛错',
  async (_name, expected, reply) => {
    const db = database();
    const appId = newAppId('live-sms');
    const outId = alertKey();
    await seedClaimedLog(db, { appId, dedupeKey: outId });
    const resolver = memoryResolver({ UNION_AUTH_EXPIRING: templateOf(ALERT_REG) });
    const r = live(db, [reply, OK_REPLY], resolver);
    const outcome = observe(r.sender.send(alertMessage(appId, outId)));
    await until(() => outcome.settled !== 'pending');
    await r.scheduler.advance(60_000);
    expect({ settled: outcome.settled, value: outcome.value, calls: r.calls.length }).toEqual({
      settled: 'resolved',
      value: expected,
      calls: 1,
    });
    expect(await logRow(db, appId, outId)).toEqual({
      channel: 'sms',
      status: 'failed',
      sent_at: null,
      row_version: 1,
      sms_biz_id: null,
    });
    expect(fullText({ calls: r.calls, outcome })).not.toContain(CONFIG.accessKeySecret);
  },
);

it('[AC-B1-12y#11] 通道超时：按登记表 sms 行的时限中止请求，结果 unknown，只发一次，不写 BizId', async () => {
  const db = database();
  const appId = newAppId('live-sms');
  const outId = alertKey();
  await seedClaimedLog(db, { appId, dedupeKey: outId });
  const resolver = memoryResolver({ UNION_AUTH_EXPIRING: templateOf(ALERT_REG) });
  const r = live(db, ['hang', OK_REPLY], resolver);
  const timeoutMs = r.registry.entry('sms').policy.timeoutMs;
  const outcome = observe(r.sender.send(alertMessage(appId, outId)));
  await until(() => r.calls.length > 0);
  const before = { settled: outcome.settled, calls: r.calls.length };
  await r.scheduler.advance(timeoutMs);
  await until(() => outcome.settled !== 'pending');
  await r.scheduler.advance(60_000);
  expect({
    before,
    settled: outcome.settled,
    value: outcome.value,
    calls: r.calls.length,
    aborted: r.calls[0]?.init.signal.aborted,
  }).toEqual({
    before: { settled: 'pending', calls: 1 },
    settled: 'resolved',
    value: 'unknown',
    calls: 1,
    aborted: true,
  });
  expect((await logRow(db, appId, outId)).sms_biz_id).toBeNull();
});

it("[AC-B1-12y#12] BizId 只写 app_id + dedupe_key = outId 且 channel = 'sms' 的那一行：别的 app 同键、同 app 别的键、同键的非短信行都不动", async () => {
  const db = database();
  const appId = newAppId('live-sms');
  const otherApp = newAppId('live-sms');
  const target = alertKey('d14', 'phone-a');
  const sibling = alertKey('d14', 'phone-b');
  const inboxKey = alertKey('d7', 'phone-a');
  await seedClaimedLog(db, { appId, dedupeKey: target });
  await seedClaimedLog(db, { appId: otherApp, dedupeKey: target });
  await seedClaimedLog(db, { appId, dedupeKey: sibling });
  await seedClaimedLog(db, { appId, dedupeKey: inboxKey, channel: 'inbox' });
  const r = live(
    db,
    [okReply('biz-target'), okReply('biz-inbox-key')],
    memoryResolver({ UNION_AUTH_EXPIRING: templateOf(ALERT_REG) }),
  );
  const first = await r.sender.send(alertMessage(appId, target));
  const second = await r.sender.send(alertMessage(appId, inboxKey));
  expect({ first, second, calls: r.calls.length }).toEqual({
    first: 'accepted',
    second: 'accepted',
    calls: 2,
  });
  expect({
    target: (await logRow(db, appId, target)).sms_biz_id,
    otherApp: (await logRow(db, otherApp, target)).sms_biz_id,
    sibling: (await logRow(db, appId, sibling)).sms_biz_id,
    inbox: (await logRow(db, appId, inboxKey)).sms_biz_id,
  }).toEqual({ target: 'biz-target', otherApp: null, sibling: null, inbox: null });
});

it('[AC-B1-12y#13] 接上站长告警端口：每个号码一次 SendSms（登记的签名与模板 CODE、BR-TEXT-20 变量、OutId = 去重键），受理的行 success 且 sms_biz_id = 该次请求的 BizId', async () => {
  const db = database();
  const appId = newAppId('live-alert');
  const { logger } = memoryLogger('worker');
  const clock = new FixedClock(AT);
  const unionAccountId = randomUUID();
  await seedUnionAccount(db, { appId, id: unionAccountId, expiresAt: new Date(EXPIRES_ISO) });
  await seedTemplate(db, {
    appId,
    code: 'UNION_AUTH_EXPIRING',
    channels: ['sms'],
    active: ALERT_REG,
  });
  const resolver = createRegisteredTemplateResolver({ db, logger, deployVerifyCode: DEPLOY });
  const replies = [okReply('biz-alert-1'), okReply('biz-alert-2')];
  const r = live(db, replies, resolver);
  const port = createSiteAuthAlertPort({ db, clock, logger, sms: r.sender });
  const phones = [
    { phoneId: 'phone-a', phone: '13800138000' },
    { phoneId: 'phone-b', phone: '13900139000' },
  ];
  const plan: SiteAuthAlertPlan = {
    appId,
    unionAccountId,
    platform: 'taobao',
    authExpiresAt: new Date(EXPIRES_ISO),
    stage: 'd14',
    code: 'UNION_AUTH_EXPIRING',
    phoneIds: phones.map((p) => p.phoneId),
  };
  await db.transaction().execute((trx) => port.plan(trx, plan));
  await port.deliver(appId, unionAccountId, phones);

  expect(r.calls).toHaveLength(2);
  const rows = await db
    .selectFrom('notify_logs')
    .select(['dedupe_key', 'status', 'sms_biz_id'])
    .where('app_id', '=', appId)
    .orderBy('dedupe_key')
    .execute();
  const byKey = new Map(rows.map((row) => [row.dedupe_key, row]));
  const seen = r.calls.map((call, index) => {
    const query = requestView(call).query.params;
    return {
      phone: query['PhoneNumbers'],
      signName: query['SignName'],
      templateCode: query['TemplateCode'],
      params: JSON.parse(query['TemplateParam'] ?? 'null') as unknown,
      row: byKey.get(query['OutId'] ?? ''),
      bizId: `biz-alert-${String(index + 1)}`,
    };
  });
  expect(seen.map((s) => s.phone).sort()).toEqual(['13800138000', '13900139000']);
  for (const s of seen) {
    expect(s).toEqual({
      phone: s.phone,
      signName: ALERT_REG.signName,
      templateCode: ALERT_REG.templateCode,
      params: ALERT_PARAMS,
      row: { dedupe_key: expect.any(String), status: 'success', sms_biz_id: s.bizId },
      bizId: s.bizId,
    });
  }
  expect(rows).toHaveLength(2);
  expect(fullText(r.calls)).not.toContain(CONFIG.accessKeySecret);
});

it('[AC-B1-12y#14] 接上站长告警端口：该编码只有「待测试」登记（没有在用登记）→ 不发请求，行 failed，不写 BizId', async () => {
  const db = database();
  const appId = newAppId('live-alert');
  const { logger } = memoryLogger('worker');
  const clock = new FixedClock(AT);
  const unionAccountId = randomUUID();
  await seedUnionAccount(db, { appId, id: unionAccountId, expiresAt: new Date(EXPIRES_ISO) });
  await seedTemplate(db, {
    appId,
    code: 'UNION_AUTH_EXPIRED',
    channels: ['sms'],
    pending: PENDING_REG,
  });
  await seedTemplate(db, {
    appId,
    code: 'UNION_AUTH_EXPIRING',
    channels: ['sms'],
    active: ALERT_REG,
  });
  const resolver = createRegisteredTemplateResolver({ db, logger, deployVerifyCode: DEPLOY });
  const r = live(db, [OK_REPLY], resolver);
  const port = createSiteAuthAlertPort({ db, clock, logger, sms: r.sender });
  const phones = [{ phoneId: 'phone-a', phone: '13800138000' }];
  const plan: SiteAuthAlertPlan = {
    appId,
    unionAccountId,
    platform: 'taobao',
    authExpiresAt: new Date(EXPIRES_ISO),
    stage: 'expired',
    code: 'UNION_AUTH_EXPIRED',
    phoneIds: ['phone-a'],
  };
  await db.transaction().execute((trx) => port.plan(trx, plan));
  await port.deliver(appId, unionAccountId, phones);
  const rows = await db
    .selectFrom('notify_logs')
    .select(['code', 'status', 'sent_at', 'sms_biz_id'])
    .where('app_id', '=', appId)
    .execute();
  expect({ calls: r.calls.length, rows }).toEqual({
    calls: 0,
    rows: [{ code: 'UNION_AUTH_EXPIRED', status: 'failed', sent_at: null, sms_biz_id: null }],
  });
});
