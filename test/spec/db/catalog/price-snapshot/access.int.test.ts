// Tests the storage capabilities, not B1-17b's comparison, throttling or lock protocol.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  connect,
  disconnect,
  ensureMonths,
  partitionsOf,
  sqlState,
  type Roles,
} from '../../partitions/kit.ts';
import { TIMEOUT, columns, fixture, insert, ready } from './kit.ts';

let database: TestDatabase;
let roles: Roles;

beforeAll(async () => {
  database = await createTestDatabase();
  roles = connect(database);
}, TIMEOUT);

afterAll(async () => {
  if (roles) await disconnect(roles);
  if (database) await database.drop();
}, TIMEOUT);

it(
  '[AC-B1-17a#12] app can lock, insert multiple runs and touch only the latest row in one transaction',
  async () => {
    await ready(roles.app);
    expect(
      await sqlState(
        roles.app.transaction().execute(async (trx) => {
          await sql`SELECT pg_advisory_xact_lock(1717, 12)`.execute(trx);
          await insert(trx, fixture({ product_key: 'tb:run-capability' }));
          await insert(
            trx,
            fixture({
              product_key: 'tb:run-capability',
              final_price_fen: 4200n,
              first_observed_at: '2032-06-15T09:00:00Z',
              last_observed_at: '2032-06-15T09:00:00Z',
            }),
          );
          const latest = await sql<{ id: bigint }>`
      SELECT id FROM app.price_snapshot
      WHERE app_id = 'couli' AND product_key = 'tb:run-capability' AND source_kind = 'detail'
      ORDER BY first_observed_at DESC LIMIT 1
    `.execute(trx);
          expect(latest.rows).toHaveLength(1);
          expect(typeof latest.rows[0]?.id).toBe('bigint');
          const updated = await sql<{ observation_count: number }>`
      UPDATE app.price_snapshot SET last_observed_at = '2032-06-15T09:20:00Z',
        observation_count = observation_count + 1
      WHERE id = ${latest.rows[0]?.id} AND first_observed_at = '2032-06-15T09:00:00Z'
      RETURNING observation_count
    `.execute(trx);
          expect(updated.rows).toEqual([{ observation_count: 2 }]);
        }),
      ),
    ).toBe('ok');
    const stored = await sql<{
      final_price_fen: bigint;
      first_observed_at: Date;
      last_observed_at: Date;
      observation_count: number;
    }>`SELECT final_price_fen, first_observed_at, last_observed_at, observation_count
    FROM app.price_snapshot WHERE app_id = 'couli' AND product_key = 'tb:run-capability'
    AND source_kind = 'detail' ORDER BY first_observed_at`.execute(roles.app);
    expect(stored.rows).toEqual([
      {
        final_price_fen: 4500n,
        first_observed_at: new Date('2032-06-15T08:00:00Z'),
        last_observed_at: new Date('2032-06-15T08:00:00Z'),
        observation_count: 1,
      },
      {
        final_price_fen: 4200n,
        first_observed_at: new Date('2032-06-15T09:00:00Z'),
        last_observed_at: new Date('2032-06-15T09:20:00Z'),
        observation_count: 2,
      },
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-17a#13] app UPDATE is restricted to the two touch columns; DELETE and TRUNCATE are denied',
  async () => {
    await ready(roles.app);
    expect(await sqlState(insert(roles.app, fixture({ product_key: 'tb:app-grants' })))).toBe('ok');
    for (const { name } of await columns(roles.app)) {
      if (name === 'last_observed_at' || name === 'observation_count') continue;
      const value = name === 'id' ? sql`DEFAULT` : sql.ref(name);
      expect(
        await sqlState(
          sql`UPDATE app.price_snapshot SET ${sql.ref(name)} = ${value}
      WHERE product_key = 'tb:app-grants'`.execute(roles.app),
        ),
        name,
      ).toBe('42501');
    }
    expect(
      await sqlState(
        sql`DELETE FROM app.price_snapshot WHERE product_key = 'tb:app-grants'`.execute(roles.app),
      ),
    ).toBe('42501');
    expect(await sqlState(sql`TRUNCATE TABLE app.price_snapshot`.execute(roles.app))).toBe('42501');
    expect(
      await sqlState(
        sql`UPDATE app.price_snapshot SET observation_count = 2
    WHERE product_key = 'tb:app-grants'`.execute(roles.app),
      ),
    ).toBe('ok');
    expect(
      await sqlState(
        sql`UPDATE app.price_snapshot SET last_observed_at = '2032-06-15T09:00:00Z'
    WHERE product_key = 'tb:app-grants'`.execute(roles.app),
      ),
    ).toBe('ok');
    for (const statement of [
      sql`UPDATE app.price_snapshot SET observation_count = 0 WHERE product_key = 'tb:app-grants'`,
      sql`UPDATE app.price_snapshot SET last_observed_at = '2032-06-15T07:59:59Z' WHERE product_key = 'tb:app-grants'`,
    ])
      expect(await sqlState(statement.execute(roles.app))).toBe('23514');
    const row = await sql<{ observation_count: number; last_observed_at: Date }>`
    SELECT observation_count, last_observed_at FROM app.price_snapshot WHERE product_key = 'tb:app-grants'
  `.execute(roles.app);
    expect(row.rows).toEqual([
      { observation_count: 2, last_observed_at: new Date('2032-06-15T09:00:00Z') },
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-17a#14] readonly can SELECT only and payout cannot access history',
  async () => {
    await ready(roles.app);
    expect(await sqlState(insert(roles.app, fixture({ product_key: 'tb:role-grants' })))).toBe(
      'ok',
    );
    const visible = await sql<{ price_fen: bigint }>`SELECT price_fen FROM app.price_snapshot
    WHERE product_key = 'tb:role-grants'`.execute(roles.readonly);
    expect(visible.rows).toEqual([{ price_fen: 5000n }]);
    // Check each column separately: a SELECT * failure alone can hide partial grants.
    for (const { name } of await columns(roles.app)) {
      expect(
        await sqlState(
          sql`SELECT ${sql.ref(name)} FROM app.price_snapshot`.execute(roles.readonly),
        ),
        name,
      ).toBe('ok');
      expect(
        await sqlState(sql`SELECT ${sql.ref(name)} FROM app.price_snapshot`.execute(roles.payout)),
        name,
      ).toBe('42501');
      for (const db of [roles.readonly, roles.payout]) {
        const value = name === 'id' ? sql`DEFAULT` : sql.ref(name);
        expect(
          await sqlState(
            sql`UPDATE app.price_snapshot SET ${sql.ref(name)} = ${value}`.execute(db),
          ),
          name,
        ).toBe('42501');
      }
    }
    for (const db of [roles.readonly, roles.payout]) {
      expect(await sqlState(insert(db, fixture()))).toBe('42501');
      expect(await sqlState(sql`DELETE FROM app.price_snapshot`.execute(db))).toBe('42501');
      expect(await sqlState(sql`TRUNCATE TABLE app.price_snapshot`.execute(db))).toBe('42501');
      const grants = await sql<{ privilege: string }>`
      SELECT p AS privilege FROM unnest(ARRAY['INSERT', 'UPDATE', 'REFERENCES']) p
      WHERE has_any_column_privilege(current_user, 'app.price_snapshot', p)
      UNION ALL
      SELECT p AS privilege FROM unnest(ARRAY['DELETE', 'TRUNCATE', 'TRIGGER']) p
      WHERE has_table_privilege(current_user, 'app.price_snapshot', p)
    `.execute(db);
      expect(grants.rows).toEqual([]);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-17a#15] direct DEFAULT and runtime-month access cannot bypass mutation restrictions',
  async () => {
    await ready(roles.app);
    expect(await ensureMonths(roles.maint, 'price_snapshot', ['2033-05'])).toEqual([
      'price_snapshot_p203305',
    ]);
    for (const at of ['2033-05-15T00:00:00Z', '2034-05-15T00:00:00Z']) {
      expect(
        await sqlState(
          insert(
            roles.app,
            fixture({
              product_key: 'tb:partition-grants',
              first_observed_at: at,
              last_observed_at: at,
            }),
          ),
        ),
      ).toBe('ok');
    }
    const parts = await partitionsOf(roles.app, 'price_snapshot');
    expect(parts).toHaveLength(2);
    const before =
      await sql`SELECT * FROM app.price_snapshot WHERE product_key = 'tb:partition-grants'
    ORDER BY first_observed_at`.execute(roles.app);
    expect(before.rows).toHaveLength(2);
    for (const { name } of parts) {
      const target = sql.table(`app.${name}`);
      for (const db of [roles.app, roles.readonly, roles.payout]) {
        for (const statement of [
          sql`UPDATE ${target} SET price_fen = 1`,
          sql`DELETE FROM ${target}`,
          sql`TRUNCATE TABLE ${target}`,
        ])
          expect(await sqlState(statement.execute(db)), name).toBe('42501');
      }
      for (const db of [roles.readonly, roles.payout]) {
        expect(
          await sqlState(sql`UPDATE ${target} SET observation_count = 2`.execute(db)),
          name,
        ).toBe('42501');
        expect(await sqlState(sql`INSERT INTO ${target} DEFAULT VALUES`.execute(db)), name).toBe(
          '42501',
        );
      }
      expect(await sqlState(sql`SELECT * FROM ${target}`.execute(roles.payout)), name).toBe(
        '42501',
      );
    }
    const after =
      await sql`SELECT * FROM app.price_snapshot WHERE product_key = 'tb:partition-grants'
    ORDER BY first_observed_at`.execute(roles.app);
    expect(after.rows).toEqual(before.rows);
  },
  TIMEOUT,
);
