import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type Transaction,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { createLogout } from './logout.ts';
import { unbindRevoked, type SessionPushTokens } from './push-tokens.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

// Real Kysely SQL compilation with an in-memory driver; no socket or database. Each query is
// answered with the next scripted result.
async function fixture(results: { rows: unknown[]; numAffectedRows?: bigint }[]) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    const next = results.shift() ?? { rows: [] };
    return { rows: next.rows as R[], numAffectedRows: next.numAffectedRows ?? 0n };
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  }).withSchema('app');
  handles.push(db);
  return { db, queries };
}

function port() {
  const unbind = vi.fn<SessionPushTokens['unbind']>(async () => undefined);
  const bind = vi.fn<SessionPushTokens['bind']>(async () => undefined);
  return { bind, unbind };
}

const U1 = '019a0000-0000-7000-8000-000000000001';
const U2 = '019a0000-0000-7000-8000-000000000002';

it('[AC-S1-76#3][BR-ID-07] a revocation hook sends one conditional unbinding per revoked session of that app', async () => {
  const f = await fixture([
    {
      rows: [
        { user_id: U1, sid: 'S1' },
        { user_id: U2, sid: 'S2' },
      ],
    },
  ]);
  const pushTokens = port();
  let transaction: Transaction<DB> | undefined;
  await f.db.transaction().execute(async (trx) => {
    transaction = trx;
    await unbindRevoked(pushTokens)(trx, ['S1', 'S2'], { app_id: 'couli' });
  });
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]?.sql).toBe(
    'select "user_id", "sid" from "app"."sessions" where "app_id" = $1 and "sid" in ($2, $3) order by "sid"',
  );
  expect(pushTokens.unbind.mock.calls).toEqual([
    [transaction, { app_id: 'couli', user_id: U1, sid: 'S1' }],
    [transaction, { app_id: 'couli', user_id: U2, sid: 'S2' }],
  ]);
  expect(pushTokens.bind).not.toHaveBeenCalled();
});

it('[AC-S1-76#3][BR-ID-07] a revocation hook without sids reads and unbinds nothing', async () => {
  const f = await fixture([]);
  const pushTokens = port();
  await f.db
    .transaction()
    .execute((trx) => unbindRevoked(pushTokens)(trx, [], { app_id: 'couli' }));
  expect(f.queries).toEqual([]);
  expect(pushTokens.unbind).not.toHaveBeenCalled();
});

const PRINCIPAL = {
  uid: U1,
  sid: 'S1',
  app_id: 'couli',
  device_id: '019a0000-0000-7000-8000-000000000003',
  scp: 'full',
} as const;

it('[AC-S1-76#2][BR-ID-07] logout unbinds its own (user, sid) in the revoking transaction', async () => {
  const f = await fixture([{ rows: [], numAffectedRows: 1n }]);
  const pushTokens = port();
  const clock = new FixedClock('2026-10-08T04:00:00.000Z');
  await createLogout({ db: f.db, clock, pushTokens }).logout(PRINCIPAL);
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]?.sql).toMatch(/^update "app"\."sessions" set/);
  expect(pushTokens.unbind).toHaveBeenCalledTimes(1);
  expect(pushTokens.unbind.mock.calls[0]?.[0].isTransaction).toBe(true);
  expect(pushTokens.unbind.mock.calls[0]?.[1]).toEqual({
    app_id: 'couli',
    user_id: U1,
    sid: 'S1',
  });
});

it('[AC-S1-76#2][BR-ID-07] logout of an already revoked session unbinds nothing (10002)', async () => {
  const f = await fixture([{ rows: [], numAffectedRows: 0n }]);
  const pushTokens = port();
  const clock = new FixedClock('2026-10-08T04:00:00.000Z');
  await expect(
    createLogout({ db: f.db, clock, pushTokens }).logout(PRINCIPAL),
  ).rejects.toMatchObject({ code: 10002 });
  expect(pushTokens.unbind).not.toHaveBeenCalled();
});
