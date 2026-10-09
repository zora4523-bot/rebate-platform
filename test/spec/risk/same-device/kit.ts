import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import type { createSameDeviceAccountsCheck as CreateSameDeviceAccountsCheck } from '../../../../apps/api/src/modules/risk/application/same-device-accounts.ts';
import type { createSameDeviceLoginReader as CreateSameDeviceLoginReader } from '../../../../apps/api/src/modules/identity/ports/same-device-logins.ts';
import type { FixedClock as FixedClockType } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { createRootLogger as CreateRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import { seedUser, type Kit } from '../../identity/registration/kit.ts';

// Computed imports keep Nest controllers out of the erasable-only test project.
const { createSameDeviceAccountsCheck } = (await import(
  new URL('../../../../apps/api/src/modules/risk/index.ts', import.meta.url).href
)) as { createSameDeviceAccountsCheck: typeof CreateSameDeviceAccountsCheck };
const { createSameDeviceLoginReader } = (await import(
  new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
)) as { createSameDeviceLoginReader: typeof CreateSameDeviceLoginReader };
const { FixedClock } = (await import(
  new URL('../../../../apps/api/src/modules/platform/clock/index.ts', import.meta.url).href
)) as { FixedClock: typeof FixedClockType };
const { createRootLogger } = (await import(
  new URL('../../../../apps/api/src/modules/platform/logging/logger.ts', import.meta.url).href
)) as { createRootLogger: typeof CreateRootLogger };

// openKit dynamically loads the disposable database helper and connects as couli_app.
export { openKit, closeKit, seedUser } from '../../identity/registration/kit.ts';
export type { Kit } from '../../identity/registration/kit.ts';
export const LIMIT = 'risk.device_login_accounts_limit';
export const DEDUPE = 'risk.merge_tombstone_dedupe';
export const WINDOW = 720 * 60 * 60 * 1000;
export const H = 'a'.repeat(64);
export const J = 'b'.repeat(64);
export const RULE = 'SAME_DEVICE_MULTI_ACCOUNT';

export function setup(kit: Kit) {
  const appId = `same_device_${randomUUID()}`;
  const clock = new FixedClock('2026-09-25T00:00:00.000Z');
  const values = new Map<string, unknown>();
  const failures = new Set<string>();
  const lines: string[] = [];
  const reads: { handle: Kysely<DB>; app: string; key: string }[] = [];
  // Per-test setup calls the public skeletons BEFORE SQL needing the future device_hash column.
  // Never in beforeAll: every red test must fail individually with NotImplemented.
  const service = createSameDeviceAccountsCheck({
    clock,
    logger: createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      { write: (line: string) => void lines.push(line) },
    ),
    logins: createSameDeviceLoginReader(),
    config: (handle) => ({
      configValue: async (app, key) => {
        reads.push({ handle, app, key });
        if (failures.has(key)) throw new Error('fixture configuration unavailable');
        return values.has(key) ? { value: values.get(key), version: 1 } : null;
      },
    }),
  });
  return {
    appId,
    clock,
    values,
    failures,
    lines,
    reads,
    service,
    user: (handle: Kysely<DB> = kit.db) => seedUser(handle, appId),
    judge: (user: string, ref = randomUUID(), handle: Kysely<DB> = kit.db) =>
      service.judge(handle, { app_id: appId, user_id: user, ref: { type: 'withdrawal', id: ref } }),
    login: (
      user: string,
      hash: string | null,
      at: Date | string,
      options: { method?: string; deviceIdHash?: string; handle?: Kysely<DB> } = {},
    ) => login(options.handle ?? kit.db, appId, user, hash, at, options),
  };
}
export type Fixture = ReturnType<typeof setup>;

export async function login(
  db: Kysely<DB>,
  app: string,
  user: string,
  hash: string | null,
  at: Date | string,
  options: { method?: string; deviceIdHash?: string } = {},
) {
  const result = await sql<{ id: bigint }>`INSERT INTO app.login_logs
    (app_id, user_id, device_hash, device_id_hash, ip, method, created_at)
    VALUES (${app}, ${user}, ${hash}, ${options.deviceIdHash ?? randomBytes(32).toString('hex')},
      '192.0.2.37', ${options.method ?? 'sms'}, ${new Date(at)}) RETURNING id`.execute(db);
  return result.rows[0]!.id;
}

export async function trio(f: Fixture, hash = H) {
  const a = await f.user();
  const b = await f.user();
  const c = await f.user();
  await f.login(a, hash, '2026-09-01T00:00:00Z');
  await f.login(b, hash, '2026-09-10T00:00:00Z');
  await f.login(c, hash, '2026-09-20T00:00:00Z');
  return { a, b, c };
}

export async function merge(
  kit: Kit,
  f: Fixture,
  source: string,
  target: string,
  at = '2026-09-05T00:00:00Z',
  reason = 'merged',
  status = 'deleted',
  provider = 'wechat',
) {
  await sql`UPDATE app.users SET status = ${status}, deleted_reason = ${reason}
    WHERE app_id = ${f.appId} AND id = ${source}`.execute(kit.db);
  await sql`INSERT INTO app.user_oauth
    (id, app_id, user_id, provider, union_id, merged_from_user_id, created_at, updated_at)
    VALUES (${randomUUID()}, ${f.appId}, ${target}, ${provider}, ${randomUUID()},
      ${source}, ${new Date(at)}, ${new Date(at)})`.execute(kit.db);
}

export async function localMerge(kit: Kit, f: Fixture) {
  const a = await f.user();
  const b = await f.user();
  const c = await f.user();
  await f.login(a, H, '2026-09-01T00:00:00Z');
  await f.login(b, H, '2026-09-05T00:00:00Z');
  await merge(kit, f, b, a);
  await f.login(a, H, '2026-09-05T00:00:00Z', { method: 'merge' });
  await f.login(c, H, '2026-09-10T00:00:00Z');
  return { a, b, c };
}

export async function hits(db: Kysely<DB>, app: string) {
  return db
    .withSchema('app')
    .selectFrom('risk_hits')
    .selectAll()
    .where('app_id', '=', app)
    .orderBy('id')
    .execute();
}

export async function expectMarked(f: Fixture, user: string, hash = H, rank = 3) {
  const result = await f.judge(user);
  expect(result.marked).toBe(true);
  expect(result.devices).toContainEqual({ device_hash: hash, rank });
  return result;
}

export async function snapshot(db: Kysely<DB>, app: string) {
  const users = await sql`SELECT * FROM app.users WHERE app_id = ${app} ORDER BY id`.execute(db);
  const risk = await sql`SELECT * FROM app.user_risk_state WHERE app_id = ${app}
    ORDER BY user_id`.execute(db);
  const sessions = await sql`SELECT * FROM app.sessions WHERE app_id = ${app} ORDER BY id`.execute(
    db,
  );
  return { users: users.rows, risk: risk.rows, sessions: sessions.rows };
}
