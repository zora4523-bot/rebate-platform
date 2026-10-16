import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  COUNTERS,
  DAY,
  connect,
  expectCheck,
  expectUnique,
  fixture,
  insert,
  repeat,
  requireTable,
  sqlState,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  connect(app);
});
afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

it('[AC-B1-08c#14] counter codes have a named closed CHECK while drop reasons remain open nonempty text', async () => {
  await requireTable(app, 'order_sync_counters');
  await requireTable(app, 'order_sync_drops');
  await expectCheck(app, 'order_sync_counters', 'counter', COUNTERS);
  for (const counter of COUNTERS) {
    expect(
      await sqlState(
        insert(
          app,
          'order_sync_counters',
          await fixture('order_sync_counters', {
            app_id: randomUUID(),
            counter,
          }),
        ),
      ),
    ).toBe('no error');
  }
  for (const counter of ['', 'ATTR_PARAM_INVALID', 'unknown']) {
    expect(
      await sqlState(
        insert(
          app,
          'order_sync_counters',
          await fixture('order_sync_counters', {
            app_id: randomUUID(),
            counter,
          }),
        ),
      ),
    ).toBe('23514');
  }
  for (const reason of ['NO_PAY_TIME', 'synthetic_future_drop_reason']) {
    expect(
      await sqlState(
        insert(
          app,
          'order_sync_drops',
          await fixture('order_sync_drops', {
            app_id: randomUUID(),
            reason,
          }),
        ),
      ),
    ).toBe('no error');
  }
  expect(
    await sqlState(
      insert(
        app,
        'order_sync_drops',
        await fixture('order_sync_drops', {
          app_id: randomUUID(),
          reason: '',
        }),
      ),
    ),
  ).toBe('23514');
});

it('[AC-B1-08c#15] daily aggregate uniqueness includes tenant, platform, date and counter or reason', async () => {
  for (const table of ['order_sync_counters', 'order_sync_drops'] as const) {
    await requireTable(app, table);
    const key = table === 'order_sync_counters' ? 'counter' : 'reason';
    await expectUnique(app, table, ['app_id', 'platform', 'date', key]);
    const row = await fixture(table, { app_id: randomUUID() });
    expect(await sqlState(insert(app, table, row))).toBe('no error');
    expect(await sqlState(repeat(app, table, row))).toBe('23505');
    for (const changes of [
      { app_id: randomUUID() },
      { platform: 'jd' },
      { date: '2026-10-18' },
      { [key]: table === 'order_sync_counters' ? 'attr_binding_miss' : 'synthetic_other_drop' },
    ]) {
      expect(await sqlState(repeat(app, table, row, changes))).toBe('no error');
    }
  }
});

it('[AC-B1-08c#16] daily counts preserve bigint precision, accept zero and reject negatives on INSERT and UPDATE', async () => {
  for (const table of ['order_sync_counters', 'order_sync_drops'] as const) {
    await requireTable(app, table);
    for (const count of [0n, 9007199254740993n]) {
      const row = await fixture(table, { app_id: randomUUID(), count });
      const result = await insert(app, table, row);
      expect(result.rows[0]?.['count']).toBe(count);
      expect(
        await sqlState(
          sql`UPDATE ${sql.table(`app.${table}`)} SET count = -1
        WHERE app_id = ${row['app_id']}`.execute(app),
        ),
      ).toBe('23514');
      const stored = await sql<{ count: bigint }>`SELECT count FROM ${sql.table(`app.${table}`)}
        WHERE app_id = ${row['app_id']}`.execute(app);
      expect(stored.rows).toEqual([{ count }]);
    }
    expect(
      await sqlState(
        insert(
          app,
          table,
          await fixture(table, {
            app_id: randomUUID(),
            count: -1n,
          }),
        ),
      ),
    ).toBe('23514');
    for (const column of [
      'app_id',
      'platform',
      'date',
      'count',
      table === 'order_sync_counters' ? 'counter' : 'reason',
    ]) {
      expect(
        await sqlState(
          insert(
            app,
            table,
            await fixture(table, {
              app_id: randomUUID(),
              [column]: null,
            }),
          ),
        ),
        `${table}.${column}`,
      ).toBe('23502');
    }
  }
});

it('[AC-B1-08c#17] concurrent atomic updates retain every increment and the application-supplied day', async () => {
  for (const table of ['order_sync_counters', 'order_sync_drops'] as const) {
    await requireTable(app, table);
    const row = await fixture(table, { app_id: randomUUID(), count: 9007199254740993n });
    expect(await sqlState(insert(app, table, row))).toBe('no error');
    const updates = await Promise.all(
      Array.from({ length: 12 }, () =>
        sqlState(
          sql`
      UPDATE ${sql.table(`app.${table}`)} SET count = count + 1
      WHERE app_id = ${row['app_id']}
    `.execute(app),
        ),
      ),
    );
    expect(updates).toEqual(Array<string>(12).fill('no error'));
    const stored = await sql<{ count: bigint; day: string }>`
      SELECT count, date::text AS day FROM ${sql.table(`app.${table}`)} WHERE app_id = ${row['app_id']}
    `.execute(app);
    expect(stored.rows).toEqual([{ count: 9007199254741005n, day: DAY }]);
  }
});

it('[AC-B1-08c#18] drop deduplication uses tenant, platform, sub-order and reason', async () => {
  const table = 'order_sync_drop_keys';
  await requireTable(app, table);
  await expectUnique(app, table, ['app_id', 'platform', 'sub_order_id', 'reason']);
  const row = await fixture(table);
  const states = await Promise.all([
    sqlState(repeat(app, table, row)),
    sqlState(repeat(app, table, row)),
  ]);
  expect(states.sort()).toEqual(['23505', 'no error']);
  for (const changes of [
    { app_id: 'couli_two' },
    { platform: 'jd' },
    { sub_order_id: randomUUID() },
    { reason: 'synthetic_future_drop_reason' },
  ]) {
    expect(await sqlState(repeat(app, table, row, changes))).toBe('no error');
  }
  for (const column of ['app_id', 'platform', 'sub_order_id', 'reason']) {
    expect(await sqlState(repeat(app, table, row, { [column]: null })), column).toBe('23502');
  }
});
