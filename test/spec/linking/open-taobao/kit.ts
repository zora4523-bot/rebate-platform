import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { createContentReader } from '../../../../apps/api/src/modules/content/index.ts';
import { createLinkRegistration } from '../../../../apps/api/src/modules/linking/index.ts';
import {
  createTaobaoLinkOpen,
  type TaobaoLinkOpenOptions,
} from '../../../../apps/api/src/modules/linking/application/link-open-taobao.ts';
import type { LinkOpenInput } from '../../../../apps/api/src/modules/linking/application/link-open.ts';
import type { HandlerResult } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  DemoUnionAdapter,
  type ActivePidInput,
  type UnionPidRow,
} from '../../../../apps/api/src/modules/union/index.ts';
import { fixture } from '../open-requote/kit.ts';
import { input, pid } from '../register/kit.ts';

export const ACTIVE_PID = {
  self_buy: 'mm_101_201_301',
  share: 'mm_102_202_302',
  agent: 'mm_103_203_303',
  query: 'mm_104_204_304',
  fallback: 'mm_105_205_305',
  taolijin: 'mm_106_206_306',
};
export const PROMO = 'https://promo.example.test/synthetic-own-link';
export const TRACE = '0199a3b4-5c6d-7000-8000-000000000006';
export type Binding =
  'absent' | 'unbound' | 'pending_auth' | 'active' | 'invalid' | 'released' | 'blocked';

/** Every scenario has an isolated tenant; all persisted rows are synthetic fixtures. */
export async function setup(
  db: Kysely<DB>,
  scene: 'detail' | 'share' = 'detail',
  platform: 'taobao' | 'jd' | 'pdd' = 'taobao',
) {
  const appId = `synthetic_tb_${randomUUID().replaceAll('-', '')}`;
  const a = randomUUID();
  const b = randomUUID();
  const device = randomUUID();
  const account = randomUUID();
  const f = fixture(db, { appId, userId: a, deviceId: device });
  for (const [userId, suffix] of [
    [a, '1'],
    [b, '2'],
  ] as const) {
    await db
      .insertInto('users')
      .values({
        id: userId,
        app_id: appId,
        nickname: '合成用户',
        avatar: 'https://example.test/avatar',
        invite_code: `demo${suffix}`,
        attr_code: `demo000${suffix}`,
        level: 'T1',
        register_method: 'synthetic',
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      })
      .execute();
    await db
      .insertInto('user_risk_state')
      .values({
        app_id: appId,
        user_id: userId,
        state: 'normal',
        changed_by: 'synthetic-fixture',
        changed_at: f.clock.now(),
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      })
      .execute();
  }
  await db
    .insertInto('devices')
    .values({
      id: device,
      app_id: appId,
      device_hash: createHash('sha256').update(device).digest('hex'),
      id_source: 'idfv',
      install_secret_cipher: Buffer.from('synthetic-unused-cipher'),
      platform: 'ios',
      app_version: '2.0.0',
      last_seen_at: f.clock.now(),
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .execute();
  await db
    .insertInto('union_accounts')
    .values({
      id: account,
      app_id: appId,
      platform,
      account_name: 'synthetic-account',
      status: 'active',
      auth_status: 'active',
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .execute();
  f.options.attrCodes!.attrCode = vi.fn(async (_app: string, userId: string) =>
    userId === a ? 'demo0001' : 'demo0002',
  );
  const adapter = new DemoUnionAdapter({
    platform,
    seed: 'synthetic-open-taobao',
    clock: f.clock,
    environment: 'test',
  });
  const convert = vi.spyOn(adapter, 'convert');
  const resolveLink = vi.spyOn(adapter, 'resolveLink');
  let raw = '00012345';
  let product = 'tb:synthetic_item';
  if (platform !== 'taobao') {
    const page = await adapter.searchItems(
      { keyword: '演示商品' },
      { appId, requestId: TRACE, purpose: 'online' },
    );
    const item = page.items[0]!;
    raw = (platform === 'jd' ? (item.itemId ?? item.skuId) : item.goods_sign)!;
    product = platform === 'jd' ? `jd:i_${raw.split('_')[1]}` : `pdd:${item.goods_id}`;
  }
  const original = input();
  const value = {
    ...original,
    ref: { ...original.ref, appId, platform, productKey: product, rawItemId: raw },
    item: {
      ...original.item,
      platform,
      item_id: raw,
      ...(platform === 'pdd' ? { goods_sign: raw } : {}),
      price_fen: 2990n,
      coupon_fen: 0n,
      final_price_fen: 2990n,
      coupon_ids: '',
      quoted_at: f.clock.now().toISOString(),
    },
  };
  const registration = createLinkRegistration({ ...f.options, context: { scene } });
  const { linkId } = await registration.register(value);
  f.state.price = {
    kind: 'available',
    input: { item: value.item, ref: value.ref, entrySource: value.entrySource, stale: false },
  };
  f.fetch.mockImplementation(async () => {
    const price = f.state.price;
    return price.kind === 'available'
      ? {
          ...price,
          input: {
            ...price.input,
            item: { ...price.input.item, quoted_at: f.clock.now().toISOString() },
          },
        }
      : price;
  });
  const row = await db
    .selectFrom('links')
    .selectAll()
    .where('link_id', '=', linkId)
    .executeTakeFirstOrThrow();
  const getActivePid = vi.fn(async (query: ActivePidInput): Promise<UnionPidRow | null> => ({
    ...pid(query),
    union_account_id: account,
    pid: ACTIVE_PID[query.pidScene],
  }));
  f.config.set(`convert.enabled.${platform}`, true);
  f.config.set('link.open.requote_after_sec', 0);
  f.config.set('attr.click_code.jd', false);
  f.config.set('attr.click_code.pdd', false);
  const content = createContentReader({ db, clock: f.clock });
  const configValue = vi.fn(
    async (tenant: string, key: string) =>
      (await content.configValue(tenant, key)) ?? f.options.config.configValue(tenant, key),
  );
  const canary = Buffer.from('synthetic application credential for taobao open').toString(
    'base64url',
  );
  const resolve = vi.fn<TaobaoLinkOpenOptions['authApps']['resolve']>(
    async (_app, env, client, method) => ({
      ref: `synthetic/${env}/${client}/${method}`,
      app_secret: canary,
    }),
  );
  const warn = vi.fn();
  const { conversion: unused, ...requote } = f.options;
  void unused;
  const options: TaobaoLinkOpenOptions = {
    ...requote,
    config: { configValue },
    pids: { getActivePid },
    registry: { get: () => adapter },
    logger: { warn },
    environment: {
      appEnv: 'test',
      apps: JSON.parse(
        readFileSync(new URL('contracts/apps.json', ROOT), 'utf8'),
      ) as TaobaoLinkOpenOptions['environment']['apps'],
      verifiedPaths: {},
    },
    appEnv: 'test',
    authApps: { resolve },
  };
  const sessions = () =>
    db.selectFrom('union_auth_sessions').selectAll().where('app_id', '=', appId).execute();
  const logs = () =>
    db
      .selectFrom('link_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .where('event', '=', 'open')
      .orderBy('id')
      .execute();
  const attempts = () =>
    db.selectFrom('link_open_attempts').selectAll().where('app_id', '=', appId).execute();
  const links = () =>
    db.selectFrom('links').selectAll().where('app_id', '=', appId).orderBy('link_id').execute();
  const bind = async (
    status: Binding,
    userId = a,
    relationId = userId === a ? 'rel-A' : 'rel-B',
  ) => {
    if (status === 'absent') return;
    await db
      .insertInto('union_bindings')
      .values({
        id: randomUUID(),
        app_id: appId,
        user_id: userId,
        platform,
        union_account_id: account,
        status,
        relation_id: relationId,
        blocked_reason: status === 'blocked' ? 'admin_disable' : null,
        released_at: status === 'released' ? f.clock.now() : null,
        cooldown_until: status === 'released' ? f.clock.now() : null,
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      })
      .execute();
  };
  const promo = async (url: string | null = PROMO, fetchedAt: Date | null = f.clock.now()) => {
    await db
      .updateTable('links')
      .set({ promo_url: url, promo_url_fetched_at: fetchedAt })
      .where('link_id', '=', linkId)
      .execute();
  };
  const opener = (userId: string | null) =>
    f.current.mockResolvedValue({ appId, userId, deviceId: device });
  const request = (extra: Partial<LinkOpenInput> = {}): LinkOpenInput =>
    f.request(linkId, { traceId: TRACE, ...extra });
  return {
    db,
    f,
    appId,
    a,
    b,
    device,
    account,
    row,
    platform,
    options,
    getActivePid,
    warn,
    convert,
    resolveLink,
    canary,
    resolve,
    sessions,
    logs,
    attempts,
    links,
    bind,
    promo,
    opener,
    request,
  };
}

export type Fixture = Awaited<ReturnType<typeof setup>>;
const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
let schemas: Promise<Record<string, JsonSchema>> | undefined;
async function validate(value: unknown, name: 'OpenLinkResponse' | 'ErrorEnvelope') {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  schemas ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)))
    .then((doc) => doc.components.schemas);
  const check = createValidatorCompiler()({ schema: (await schemas)[name]!, httpPart: 'body' });
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}

/** Mandatory task invariant on EVERY successful open, including replays and jd/pdd regressions. */
export async function checkResponse(result: HandlerResult, f: Fixture) {
  expect(JSON.stringify(result)).not.toContain(f.canary);
  await validate(
    result.envelope,
    result.envelope.code === 0 ? 'OpenLinkResponse' : 'ErrorEnvelope',
  );
  if (f.platform === 'taobao') {
    expect(f.convert).not.toHaveBeenCalled();
    expect(f.resolveLink).not.toHaveBeenCalled();
  }
  if (result.envelope.code !== 0) return;
  const data = result.envelope.data as components['schemas']['OpenLinkResult'];
  for (const step of [data.jump.primary, ...data.jump.fallbacks]) {
    expect(Object.hasOwn(step, 'sdk')).toBe(step.type === 'sdk');
    if (step.type !== 'sdk') continue;
    expect(step.sdk).toBeDefined();
    const sdk = step.sdk!;
    expect(sdk.provider).toBe('baichuan');
    expect(['url', 'code']).toContain(sdk.open_by);
    if (sdk.open_by === 'url') {
      expect(Object.keys(sdk).sort()).toEqual(['open_by', 'provider', 'url']);
      expect(step.value).toBe(sdk.url);
      expect(sdk.url).toMatch(/^https:\/\//);
    } else {
      expect(sdk).toMatchObject({
        page: 'detail',
        item_id: expect.any(String),
        taoke: { pid: expect.stringMatching(/^mm_\d+_\d+_\d+$/) },
      });
      expect(sdk).not.toHaveProperty('url');
      expect(step.value).toBe(sdk.item_id);
    }
  }
}

export function compose(f: Fixture, patch: Partial<TaobaoLinkOpenOptions> = {}) {
  // Construction stays outside rejection assertions: the skeleton itself must make every case red.
  const service = createTaobaoLinkOpen({ ...f.options, ...patch });
  return async (request = f.request()) => {
    const result = await service.open(request);
    await checkResponse(result, f);
    return result;
  };
}

export function success(result: HandlerResult) {
  expect(result).toMatchObject({ status: 200, envelope: { code: 0 } });
  return result.envelope.data as components['schemas']['OpenLinkResult'];
}

export function codeJump(
  result: HandlerResult,
  f: Fixture,
  scene: keyof typeof ACTIVE_PID = 'self_buy',
  relation: string | null = 'rel-A',
) {
  const data = success(result);
  expect(data.jump.primary).toEqual({
    type: 'sdk',
    value: f.row.raw_item_id,
    sdk: {
      provider: 'baichuan',
      open_by: 'code',
      page: 'detail',
      item_id: f.row.raw_item_id,
      taoke: { pid: ACTIVE_PID[scene], ...(relation === null ? {} : { relation_id: relation }) },
    },
  });
  expect(data.jump.fallbacks).toEqual([]);
  return data;
}

export function urlJump(result: HandlerResult) {
  const data = success(result);
  expect(data.jump.primary).toEqual({
    type: 'sdk',
    value: PROMO,
    sdk: { provider: 'baichuan', open_by: 'url', url: PROMO },
  });
  for (const step of data.jump.fallbacks) {
    if (step.type !== 'sdk') expect(step.value).toBe(PROMO);
    // BR-ATTR-27 淘宝行：有我方推广链接时只 openByUrl，任何步骤都不带推广位与用户参数。
    else expect(step.sdk).toEqual({ provider: 'baichuan', open_by: 'url', url: PROMO });
  }
  const serialized = JSON.stringify(data.jump);
  for (const forbidden of ['taoke', 'relation_id', '"pid"', 'open_by":"code', 'rel-A', 'rel-B'])
    expect(serialized).not.toContain(forbidden);
  for (const pid of Object.values(ACTIVE_PID)) expect(serialized).not.toContain(pid);
  return data;
}

export async function failure(result: HandlerResult, f: Fixture, code: number, status = 422) {
  expect(result).toMatchObject({ status, envelope: { code } });
  expect(result.envelope.data ?? {}).not.toHaveProperty('jump');
  expect(await f.attempts()).toEqual([]);
}

export async function noAuthState(result: HandlerResult, f: Fixture) {
  for (const key of ['auth_url', 'state', 'auth_methods'])
    expect(result.envelope.data ?? {}).not.toHaveProperty(key);
  expect(await f.sessions()).toEqual([]);
}
