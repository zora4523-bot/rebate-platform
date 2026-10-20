// Helpers of the F1-10e rule tests: the admin configuration center (contracts/openapi.yaml
// adminListConfigItems, adminGetConfigItem, adminListConfigItemVersions, adminUpdateConfigItem,
// adminBatchUpdateConfigItems, adminRollbackConfigItem). Built on the frozen admin kits
// (test/spec/admin/auth, accounts), which are only imported here.
//
// Readings fixed by this kit (contract text and orchestrator rulings 7, 14～16):
// - the registry oracle below is ruling 14 verbatim: key, JSON value type of the seed, permission
//   point, admin_editable; options is null for every key (no enum among them);
// - F1-02zi (test-change, transitional; F1-02zt tightens): F1-02zj appends the BR-FUND-04
//   settle.* group (SETTLE below, 16 literal keys) to the registry and the 0001 seed. Until it
//   lands either the bare ruling 14 registry or ruling 14 plus the whole group is accepted,
//   never part of the group (expectedNow); EXPECTED itself stays ruling 14 verbatim;
// - audit rows: action config_item_change / config_item_rollback, admin_id = the caller, at = the
//   injected clock; `before.value` / `after.value` are the old and new values (an item never
//   written may have before = null); key, from_version, to_version and reason are facts of
//   `before` ∪ `after` (the key may instead be the row's `target`);
// - alert: one pino warn line (level 40) with msg config_change_alert per changed key that names
//   the key as one of its string values; none when nothing changed or the transaction failed.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { configRegistry } from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { grant, seed, type Seed } from '../../admin/accounts/kit.ts';
import {
  apiRequire,
  factory,
  fixture,
  signedIn,
  totp,
  type Harness,
  type HttpApp,
  type Response,
} from '../../admin/auth/kit.ts';

export type Item = Schema<'AdminConfigItem'>;
export type Version = Schema<'AdminConfigItemVersion'>;
export type ItemPage = Schema<'AdminConfigItemPage'>;
export type VersionPage = Schema<'AdminConfigItemVersionPage'>;
export type Permission = 'config.general' | 'config.risk' | 'config.business';
// 'enum' only for the F1-02zi transitional SETTLE group (F1-02zt tightens).
export type ValueType = 'boolean' | 'number' | 'string' | 'object' | 'enum';

export const LIST = '/admin/v1/config-items';
export const OPERATIONS = ['list', 'get', 'versions', 'update', 'batch', 'rollback'] as const;
export type Operation = (typeof OPERATIONS)[number];
export const ROUTES = {
  list: { method: 'GET', path: LIST },
  get: { method: 'GET', path: `${LIST}/{key}` },
  versions: { method: 'GET', path: `${LIST}/{key}/versions` },
  update: { method: 'PUT', path: `${LIST}/{key}` },
  batch: { method: 'POST', path: `${LIST}/batch` },
  rollback: { method: 'POST', path: `${LIST}/{key}/rollback` },
} as const;
export const READS = ['list', 'get', 'versions'] as const;
export const WRITES = ['update', 'batch', 'rollback'] as const;
export const ALL_POINTS: readonly Permission[] = [
  'config.general',
  'config.risk',
  'config.business',
];

export interface Expected {
  readonly key: string;
  readonly valueType: ValueType;
  readonly permission: Permission;
  readonly adminEditable: boolean;
  /** F1-02zi (transitional): options of an enum item; absent means null. */
  readonly options?: readonly string[];
}
const row = (
  key: string,
  valueType: ValueType,
  permission: Permission,
  adminEditable = true,
): Expected => ({ key, valueType, permission, adminEditable });

/** Ruling 14 (couli-runs/F1-10a/decision-orchestrator.md 裁定 14), key by key. */
export const EXPECTED: readonly Expected[] = [
  row('withdraw.payout_account_verify_per_day', 'number', 'config.business'),
  row('withdraw.payout_account_verify_inflight_timeout_sec', 'number', 'config.business'),
  row('withdraw.payout_account_verify_recheck_minutes', 'number', 'config.business'),
  row('withdraw.payout_account_verify_reuse_hours', 'number', 'config.business'),
  row('rebate.pdd.compare_precheck.enabled', 'boolean', 'config.business'),
  row('settle.estimate_change_diff.enabled', 'boolean', 'config.business', false),
  row('settle.adjust.void_on_clawback.enabled', 'boolean', 'config.business', false),
  row('order_sync.regression_hold.enabled', 'boolean', 'config.business', false),
  row('order_sync.unmapped_status_hold.enabled', 'boolean', 'config.business', false),
  row('ledger.bad_debt_require_no_frozen.enabled', 'boolean', 'config.business', false),
  row('payout.proven_success_writeoff.enabled', 'boolean', 'config.business', false),
  row('risk.merge_tombstone_dedupe', 'boolean', 'config.risk'),
  row('auth.oauth_attempt_ttl_sec', 'number', 'config.risk'),
  row('push.token_conflict_window_hours', 'number', 'config.risk'),
  row('attr.track_complete_tolerance_sec', 'number', 'config.risk'),
  row('external_page.union_host_block', 'boolean', 'config.risk'),
  row('union.taobao.auth_methods.ios', 'object', 'config.general'),
  row('union.taobao.auth_methods.android', 'object', 'config.general'),
  row('union.taobao.auth_methods.harmony', 'object', 'config.general'),
  row('external_page.nav_host_sample_bp', 'number', 'config.general'),
  row('share.open_in_app.enabled', 'boolean', 'config.general'),
  row('invite.bind_phone_guide', 'boolean', 'config.general'),
  row('invite.before_buy_tip', 'boolean', 'config.general'),
  row('earnings.dashboard.enabled', 'boolean', 'config.general'),
  row('earnings.dashboard.referral_visible', 'boolean', 'config.general'),
  row('order.user_query_months', 'number', 'config.general'),
  row('app_update.recheck_interval_sec', 'number', 'config.general'),
  row('agent.page_guide.routes', 'object', 'config.general', false),
  row('external_hosts', 'object', 'config.general', false),
];

// F1-02zi (test-change, transitional; F1-02zt tightens to EXPECTED + SETTLE only).
// The BR-FUND-04 细则 settle.* parameters as F1-02zj registers them (couli-runs/F1-02zj
// excerpt 9.2-1/2): appended after external_hosts in this order, platforms taobao / jd / pdd /
// meituan, every one config.business and editable.
const PLATFORMS = ['taobao', 'jd', 'pdd', 'meituan'] as const;
const enumRow = (key: string, options: readonly string[]): Expected => ({
  ...row(key, 'enum', 'config.business'),
  options,
});
export const SETTLE: readonly Expected[] = [
  row('settle.bill_day', 'number', 'config.business'),
  ...PLATFORMS.map((p) => enumRow(`settle.period_basis.${p}`, ['received_at'])),
  ...PLATFORMS.map((p) => enumRow(`settle.statement_source.${p}`, ['api', 'upload'])),
  row('settle.batch.match_tolerance_fen', 'number', 'config.business'),
  row('settle.batch.max_orders', 'number', 'config.business'),
  ...PLATFORMS.map((p) => row(`settle.period_offset_months.${p}`, 'number', 'config.business')),
  row('settle.statement.grace_days', 'number', 'config.business'),
];
/**
 * F1-02zi (transitional): the registry oracle for the build under test. The SETTLE group must be
 * registered whole or not at all (a partial group fails here); with it the oracle is EXPECTED
 * followed by SETTLE, without it EXPECTED alone.
 */
export function expectedNow(): readonly Expected[] {
  const registered = new Set(configRegistry().map((spec) => spec.key));
  const present = SETTLE.filter((entry) => registered.has(entry.key)).length;
  expect([0, SETTLE.length], 'settle.* group registered whole or not at all').toContain(present);
  return present === 0 ? EXPECTED : [...EXPECTED, ...SETTLE];
}
export const expectedOf = (key: string): Expected => {
  const found = expectedNow().find((entry) => entry.key === key);
  expect(found, key).toBeDefined();
  return found!;
};
/** The six money-rule flags of ruling 14 (admin_editable=false). */
export const FUND_FLAGS = [
  'settle.estimate_change_diff.enabled',
  'settle.adjust.void_on_clawback.enabled',
  'order_sync.regression_hold.enabled',
  'order_sync.unmapped_status_hold.enabled',
  'ledger.bad_debt_require_no_frozen.enabled',
  'payout.proven_success_writeoff.enabled',
] as const;

/** Keys the tests write, one editable number / boolean key per point. */
export const KEYS = {
  general: 'order.user_query_months',
  generalFlag: 'share.open_in_app.enabled',
  generalFlag2: 'invite.bind_phone_guide',
  risk: 'auth.oauth_attempt_ttl_sec',
  riskFlag: 'risk.merge_tombstone_dedupe',
  business: 'withdraw.payout_account_verify_per_day',
  business2: 'withdraw.payout_account_verify_reuse_hours',
} as const;
export const POINT_KEYS: Readonly<Record<Permission, string>> = {
  'config.general': KEYS.general,
  'config.risk': KEYS.risk,
  'config.business': KEYS.business,
};
/** Not configuration items: 04 §10.1 keys outside ruling 14, switch keys, prototype names. */
export const UNREGISTERED = [
  'invite.fail_limit_per_day',
  'level.default',
  'landing.ip_register_limit',
  'growth.invite_bind.enabled',
  'parse.tpwd.enabled',
  'convert.enabled.taobao',
  'agent.page_guide.enabled',
  'order.user_query_months.x',
  'order.user_query',
  'constructor',
  '__proto__',
  'toString',
] as const;

/** Every row of db/seeds/0001_config-defaults.sql: key → JSON value. */
export function seedRows(): ReadonlyMap<string, unknown> {
  const text = readFileSync(
    fileURLToPath(new URL('../../../../db/seeds/0001_config-defaults.sql', import.meta.url)),
    'utf8',
  );
  const result = new Map<string, unknown>();
  for (const match of text.matchAll(/\('couli', '([^']+)', '([^']*)'::jsonb/g)) {
    result.set(match[1]!, JSON.parse(match[2]!));
  }
  return result;
}
export function jsonTypeOf(value: unknown): ValueType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'object';
}

// ---- HTTP ---------------------------------------------------------------------------------

interface AnyApp {
  inject(input: {
    method: 'GET' | 'PUT' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<Response>;
}

export function hasRoute(app: HttpApp, op: Operation): boolean {
  const server = app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  const route = ROUTES[op];
  return server.hasRoute({ method: route.method, url: route.path.replace(/\{(\w+)\}/g, ':$1') });
}

export async function setup(h: Harness) {
  const f = await fixture(h);
  // Missing business routes must fail every test as an assertion, never a 404 false green.
  for (const op of OPERATIONS) expect(hasRoute(f.app, op), ROUTES[op].path).toBe(true);
  const appId = `f1-10e-${randomUUID()}`;
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  return { ...f, appId, actor, token: session.admin_token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

/** A non-super account of the same app with exactly `grants`. */
export async function member(h: Harness, f: Setup, grants: readonly string[]) {
  const who = await seed(h, f.appId);
  if (grants.length > 0) await grant(h, who, f.actor, grants);
  const session = await signedIn(f, who);
  return { who, token: session.admin_token };
}

/** A fresh totp-tier step-up token for `who` (moves the clock to a new TOTP window). */
export async function stepUp(f: Setup, who: Seed = f.actor, token: string = f.token) {
  f.clock.advanceMs(30_000);
  const response = await f.post(
    '/step-up',
    { tier: 'totp', code: totp(who.secret, f.clock) },
    { authorization: `Bearer ${token}` },
  );
  expect(response.statusCode).toBe(200);
  const data = response.json<{ data: { step_up_token: string } }>().data;
  expect(typeof data.step_up_token).toBe('string');
  return data.step_up_token;
}

export interface Call {
  key?: string;
  query?: string;
  body?: unknown;
  token?: string | null;
  stepUp?: string;
  app?: HttpApp;
}
export function call(f: Pick<Setup, 'app' | 'token'>, op: Operation, c: Call = {}) {
  const route = ROUTES[op];
  const token = c.token === undefined ? f.token : c.token;
  const url =
    route.path.replace('{key}', encodeURIComponent(c.key ?? KEYS.general)) + (c.query ?? '');
  return ((c.app ?? f.app) as unknown as AnyApp).inject({
    method: route.method,
    url,
    headers: {
      ...(route.method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(c.stepUp === undefined ? {} : { 'x-step-up-token': c.stepUp }),
    },
    ...(route.method === 'GET' ? {} : { payload: JSON.stringify(c.body ?? {}) }),
    remoteAddress: '127.0.0.1',
  });
}
export const update = (
  f: Pick<Setup, 'app' | 'token'>,
  key: string,
  body: Record<string, unknown>,
  extra: Omit<Call, 'key' | 'body'> = {},
) => call(f, 'update', { ...extra, key, body });
export const batch = (
  f: Pick<Setup, 'app' | 'token'>,
  body: Record<string, unknown>,
  extra: Omit<Call, 'key' | 'body'> = {},
) => call(f, 'batch', { ...extra, body });
export const rollback = (
  f: Pick<Setup, 'app' | 'token'>,
  key: string,
  body: Record<string, unknown>,
  extra: Omit<Call, 'key' | 'body'> = {},
) => call(f, 'rollback', { ...extra, key, body });

type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let validators: Promise<Map<string, Validator>> | undefined;
async function responseValidators() {
  validators ??= (async () => {
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(
        path: string,
        options: object,
      ): Promise<{
        paths: Record<
          string,
          Record<
            string,
            { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> }
          >
        >;
      }>;
    };
    const doc = await parser.dereference(
      fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
      { resolve: { external: false } },
    );
    const compile = createValidatorCompiler();
    const result = new Map<string, Validator>();
    for (const op of OPERATIONS) {
      const { method, path } = ROUTES[op];
      for (const status of ['200', '4XX', '5XX']) {
        const responses = doc.paths[path]![method.toLowerCase()]!.responses;
        result.set(
          `${op}:${status}`,
          compile({
            schema: responses[status]!.content['application/json']!.schema,
            httpPart: 'body',
          }),
        );
      }
    }
    return result;
  })();
  return validators;
}
export async function validate(response: Response, op: Operation) {
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const check = (await responseValidators()).get(`${op}:${status}`)!;
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}
export async function success<T>(response: Response, op: Operation): Promise<T> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response, op);
  return response.json<{ data: T }>().data;
}
export async function rejected(response: Response, op: Operation, code: number, data?: object) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(
    code === 10001
      ? 401
      : code === 10003 || code === 10403
        ? 403
        : code === 20902
          ? 409
          : code >= 50000
            ? 500
            : 400,
  );
  expect(response.json()).toMatchObject({ code });
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response, op);
}
export const keyInvalid = (response: Response, op: Operation) =>
  rejected(response, op, 20001, { fields: ['key'] });
export const valueInvalid = (response: Response, op: Operation) =>
  rejected(response, op, 20001, { fields: ['value'] });
export const conflict = (response: Response, op: Operation) =>
  rejected(response, op, 20902, { resource: 'config_item' });
export const needsTotp = (response: Response, op: Operation) =>
  rejected(response, op, 10003, { tier: 'totp' });
export const denied = (response: Response, op: Operation) =>
  rejected(response, op, 10403, { reason: 'admin_permission_denied' });

export async function getItem(f: Pick<Setup, 'app' | 'token'>, key: string): Promise<Item> {
  return success<Item>(await call(f, 'get', { key }), 'get');
}
export async function listPage(f: Pick<Setup, 'app' | 'token'>, query = ''): Promise<ItemPage> {
  return success<ItemPage>(await call(f, 'list', { query }), 'list');
}
export async function listAll(f: Pick<Setup, 'app' | 'token'>): Promise<Item[]> {
  const page = await listPage(f, '?page=1&page_size=200');
  expect(page.total).toBe(page.items.length);
  return page.items;
}
export async function historyPage(
  f: Pick<Setup, 'app' | 'token'>,
  key: string,
  query = '',
): Promise<VersionPage> {
  return success<VersionPage>(await call(f, 'versions', { key, query }), 'versions');
}

/** The item as the contract describes it, timestamps normalised to ISO. */
export function normalized(item: Item): Item {
  return {
    ...item,
    updated_at: item.updated_at === null ? null : new Date(item.updated_at).toISOString(),
  };
}
export function normalizedVersion(version: Version): Version {
  return { ...version, created_at: new Date(version.created_at).toISOString() };
}
/** The full expected item for a registered key. */
export function itemOf(
  key: string,
  state: { value: unknown; version: number; updated_by: string | null; updated_at: string | null },
): Item {
  const spec = expectedOf(key);
  return {
    key,
    value: state.value as Item['value'],
    value_type: spec.valueType,
    options: spec.options === undefined ? null : [...spec.options], // F1-02zi: null for EXPECTED
    permission: spec.permission,
    admin_editable: spec.adminEditable,
    version: state.version,
    updated_by: state.updated_by,
    updated_at: state.updated_at,
  };
}
export const unwritten = (key: string): Item =>
  itemOf(key, { value: null, version: 0, updated_by: null, updated_at: null });

// ---- database --------------------------------------------------------------------------------

export const ROW_AT = '2026-10-05T01:02:03.000Z';

/** A current-value row as a seed or an earlier write left it (no history row is added). */
export async function putRow(
  h: Harness,
  appId: string,
  key: string,
  value: unknown,
  version = 1,
  updatedBy = 'seed',
) {
  await h.db
    .insertInto('config_items')
    .values({
      app_id: appId,
      key,
      value: JSON.stringify(value),
      version,
      updated_by: updatedBy,
      created_at: ROW_AT,
      updated_at: ROW_AT,
    })
    .execute();
}
/** A stored history version. */
export async function putVersion(
  h: Harness,
  appId: string,
  key: string,
  version: number,
  value: unknown,
  by: Seed | null,
  reason: string | null = null,
  createdAt = ROW_AT,
) {
  await h.db
    .insertInto('config_item_versions')
    .values({
      app_id: appId,
      key,
      version,
      value: JSON.stringify(value),
      updated_by: by === null ? 'system' : 'history-snapshot',
      updated_by_admin_id: by === null ? null : by.id,
      reason,
      created_at: createdAt,
    })
    .execute();
}
/** Current row and stored history 1..values.length of one key (values[i] is version i + 1). */
export async function written(
  h: Harness,
  appId: string,
  key: string,
  values: readonly unknown[],
  by: Seed,
) {
  for (const [index, value] of values.entries()) {
    await putVersion(h, appId, key, index + 1, value, by, `r${index + 1}`);
  }
  await putRow(h, appId, key, values.at(-1), values.length, 'history-snapshot');
}

export async function snapshot(h: Harness, appId: string) {
  return {
    items: await h.db
      .selectFrom('config_items')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('key')
      .execute(),
    versions: await h.db
      .selectFrom('config_item_versions')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('key')
      .orderBy('version')
      .execute(),
    audits: await h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}
export type Snapshot = Awaited<ReturnType<typeof snapshot>>;
export const current = (h: Harness, appId: string, key: string) =>
  h.db
    .selectFrom('config_items')
    .selectAll()
    .where('app_id', '=', appId)
    .where('key', '=', key)
    .executeTakeFirst();
export const versionsOf = (h: Harness, appId: string, key: string) =>
  h.db
    .selectFrom('config_item_versions')
    .selectAll()
    .where('app_id', '=', appId)
    .where('key', '=', key)
    .orderBy('version')
    .execute();

/** The audit rows written since `before`. */
export async function auditsSince(h: Harness, appId: string, before: Snapshot) {
  const ids = new Set(before.audits.map((audit) => audit.id));
  return (await snapshot(h, appId)).audits.filter((audit) => !ids.has(audit.id));
}

export interface Change {
  key: string;
  from: number;
  to: number;
  before: unknown;
  after: unknown;
  reason?: string;
}
type AuditRow = Snapshot['audits'][number];
const objectOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** Checks one audit row against a change (the kit's header fixes the reading). */
export function expectAudit(
  audit: AuditRow,
  f: Pick<Setup, 'clock'>,
  actor: Seed,
  action: 'config_item_change' | 'config_item_rollback',
  change: Change,
) {
  expect(audit).toMatchObject({ app_id: actor.appId, admin_id: actor.id, action });
  expect(audit.at.toISOString()).toBe(f.clock.now().toISOString());
  const before = objectOf(audit.before);
  const after = objectOf(audit.after);
  expect(after.value).toStrictEqual(change.after);
  expect(before.value ?? null).toStrictEqual(change.before);
  const facts = { ...before, ...after };
  expect(audit.target === change.key || facts.key === change.key, 'audit names the key').toBe(true);
  expect(facts.from_version).toBe(change.from);
  if (action === 'config_item_change') expect(facts.to_version).toBe(change.to);
  if (change.reason !== undefined) expect(facts.reason).toBe(change.reason);
}
export const auditOfKey = (audits: readonly AuditRow[], key: string) => {
  const found = audits.filter(
    (audit) =>
      audit.target === key ||
      objectOf(audit.after).key === key ||
      objectOf(audit.before).key === key,
  );
  expect(found, `one audit row for ${key}`).toHaveLength(1);
  return found[0]!;
};

// ---- alert log -------------------------------------------------------------------------------

function mentions(node: unknown, key: string): boolean {
  if (node === key) return true;
  if (Array.isArray(node)) return node.some((item) => mentions(item, key));
  if (typeof node === 'object' && node !== null) {
    return Object.values(node).some((item) => mentions(item, key));
  }
  return false;
}
export function alerts(lines: readonly string[]): Record<string, unknown>[] {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((line) => line.msg === 'config_change_alert');
}
/** Alert lines added since `seen` lines; every one a warn line. */
export function alertsSince(lines: readonly string[], seen: number) {
  const added = alerts(lines.slice(seen));
  for (const line of added) expect(line.level).toBe(40);
  return added;
}
export function expectAlerted(lines: readonly string[], seen: number, keys: readonly string[]) {
  const added = alertsSince(lines, seen);
  expect(added.length).toBeGreaterThan(0);
  for (const key of keys) {
    expect(
      added.filter((line) => mentions(line, key)),
      `one config_change_alert for ${key}`,
    ).toHaveLength(1);
  }
}

/** An admin-entry app on another database handle (fault injection or statement capture). */
export async function appWith(h: Harness, f: Setup, db: Harness['db']) {
  const app = await (
    await factory()
  )('admin', {
    ...f.overrides,
    dbHandles: { db, dbRead: null, close: async () => undefined },
  });
  h.apps.push(app);
  await app.init();
  return app;
}
