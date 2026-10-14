import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import type {
  createSameDeviceAccountsCheck as CreateCheck,
  SameDeviceAccountsResult,
  SameDeviceLoginReader,
} from '../../../../apps/api/src/modules/risk/application/same-device-accounts.ts';
import type { createSameDeviceLoginReader as CreateLogins } from '../../../../apps/api/src/modules/identity/ports/same-device-logins.ts';
import type { FixedClock as Clock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { createRootLogger as CreateLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import { login, seedUser, type Kit } from '../same-device/kit.ts';

const { createSameDeviceAccountsCheck } = (await import(
  new URL('../../../../apps/api/src/modules/risk/index.ts', import.meta.url).href
)) as { createSameDeviceAccountsCheck: typeof CreateCheck };
const { createSameDeviceLoginReader } = (await import(
  new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
)) as { createSameDeviceLoginReader: typeof CreateLogins };
const { FixedClock } = (await import(
  new URL('../../../../apps/api/src/modules/platform/clock/index.ts', import.meta.url).href
)) as { FixedClock: typeof Clock };
const { createRootLogger } = (await import(
  new URL('../../../../apps/api/src/modules/platform/logging/logger.ts', import.meta.url).href
)) as { createRootLogger: typeof CreateLogger };

export { closeKit, openKit, hits, H, J, LIMIT, DEDUPE, RULE } from '../same-device/kit.ts';
export type { Kit } from '../same-device/kit.ts';

export function fixture(kit: Kit) {
  const appId = `replay_${randomUUID()}`;
  const clock = new FixedClock('2026-09-25T00:00:00.000Z');
  const values = new Map<string, unknown>();
  const failures = new Set<string>();
  const sqlFailures = new Set<string>();
  const lines: string[] = [];
  const reads: { handle: Kysely<DB>; app: string; key: string }[] = [];
  const loginReads: Kysely<DB>[] = [];
  const reader = createSameDeviceLoginReader();
  const hooks: {
    beforeRead?: (handle: Kysely<DB>, call: number) => Promise<void>;
    afterRead?: (handle: Kysely<DB>, call: number) => Promise<void>;
  } = {};
  const logins: SameDeviceLoginReader = {
    async read(handle, input) {
      loginReads.push(handle);
      const call = loginReads.length;
      await hooks.beforeRead?.(handle, call);
      const rows = await reader.read(handle, input);
      await hooks.afterRead?.(handle, call);
      return rows;
    },
  };
  // Construction stays in the test body, so a future NotImplemented skeleton fails each case.
  const service = createSameDeviceAccountsCheck({
    clock,
    logins,
    logger: createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      { write: (line: string) => void lines.push(line) },
    ),
    config: (handle) => ({
      async configValue(app, key) {
        reads.push({ handle, app, key });
        if (failures.has(key)) throw new Error('fixture configuration unavailable');
        // A real statement error poisons the transaction unless judge uses its savepoint.
        if (sqlFailures.has(key)) await sql`SELECT 1 / 0`.execute(handle);
        return values.has(key) ? { value: values.get(key), version: 1 } : null;
      },
    }),
  });
  return {
    appId,
    clock,
    values,
    failures,
    sqlFailures,
    lines,
    reads,
    loginReads,
    hooks,
    service,
    user: (handle: Kysely<DB> = kit.db) => seedUser(handle, appId),
    login: (user: string, hash: string, at: string) => login(kit.db, appId, user, hash, at),
    judge: (user: string, ref = randomUUID(), handle: Kysely<DB> = kit.db) =>
      service.judge(handle, { app_id: appId, user_id: user, ref: { type: 'withdrawal', id: ref } }),
  };
}
export type Fixture = ReturnType<typeof fixture>;

export async function accounts(f: Fixture, count: 2 | 3, hash: string) {
  const users: string[] = [];
  for (let index = 0; index < count; index++) {
    const user = await f.user();
    users.push(user);
    await f.login(user, hash, ['2026-09-01', '2026-09-10', '2026-09-20'][index]! + 'T00:00:00Z');
  }
  return users;
}

export interface Judgement {
  id: bigint;
  app_id: string;
  rule_id: string;
  ref_type: string;
  ref_id: string;
  user_id: string;
  marked: boolean;
  result: SameDeviceAccountsResult;
  judged_at: Date;
  created_at: Date;
}

export async function judgements(handle: Kysely<DB>, app: string): Promise<Judgement[]> {
  // The migration belongs to the implementation phase. Absence is an explicit schema assertion,
  // never an undefined_table error masquerading as valid red evidence. No generated DB edits.
  const table = await sql<{ name: string | null }>`
    SELECT to_regclass('app.risk_judgements')::text AS name`.execute(handle);
  expect(table.rows[0]?.name, 'B1-03n 必须有持久化判定结果表').toBe('app.risk_judgements');
  const result = await sql<Judgement>`SELECT * FROM app.risk_judgements
    WHERE app_id = ${app} ORDER BY id`.execute(handle);
  return result.rows;
}

export async function seedRule(f: Fixture, kit: Kit, rule: string) {
  await sql`INSERT INTO app.risk_rules
    (id, app_id, rule_id, scene, conditions, risk_action, status, version, created_at, updated_at)
    VALUES (${randomUUID()}, ${f.appId}, ${rule}, 'withdrawal', '{}'::jsonb,
      'manual_review', 'active', 1, ${f.clock.now()}, ${f.clock.now()})
    ON CONFLICT (app_id, rule_id) DO NOTHING`.execute(kit.db);
}

export function signal() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
