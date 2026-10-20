import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { createKyselyConfigItemStore } from './kysely-config-item-store.ts';
import { createKyselyKillSwitchStore } from './kysely-kill-switch-store.ts';

const APP_ID = 'invite-guard-test';
const KEYS = ['growth.invite_reward.amount_fen', 'growth.invite_reward.total_budget_fen'];
const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

// Real SQL compiler, no database or socket.
async function fixture() {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    return { rows: [{ key: KEYS[0], value: 100 }] as R[] };
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  handles.push(db);
  const append = async () => undefined;
  return {
    queries,
    stores: [
      createKyselyConfigItemStore(db, () => ({ append })),
      createKyselyKillSwitchStore(db, () => ({ append })),
    ],
  };
}

it('[AC-F1-02zn#17] 单元：两条写路径取同一把按 app 区分的事务级锁', async () => {
  const f = await fixture();
  for (const store of f.stores) {
    await store.transaction((tx) => tx.lockInviteReward(APP_ID));
  }
  expect(f.queries).toHaveLength(2);
  for (const query of f.queries) {
    expect(query.sql).toBe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
    expect(query.parameters).toStrictEqual([`content.invite_reward:${APP_ID}`]);
  }
});

it('[AC-F1-02zn#17] 单元：读当前值按完整键名与 app_id 取，不用前缀匹配', async () => {
  const f = await fixture();
  for (const store of f.stores) {
    const values = await store.transaction((tx) => tx.values(APP_ID, KEYS));
    expect([...values.entries()]).toStrictEqual([[KEYS[0], 100]]);
  }
  expect(f.queries).toHaveLength(2);
  for (const query of f.queries) {
    expect(query.sql).toContain('from "app"."config_items"');
    expect(query.sql).toContain('"key" in ($2, $3)');
    expect(query.sql.toLowerCase()).not.toContain('like');
    expect(query.parameters).toStrictEqual([APP_ID, ...KEYS]);
  }
  const empty = await f.stores[0]!.transaction((tx) => tx.values(APP_ID, []));
  expect(empty.size).toBe(0);
  expect(f.queries).toHaveLength(2);
});
