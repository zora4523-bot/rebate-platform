import { MONTH_PARTITIONED_TABLES } from '@couli/db';
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
import { TIMEOUT, fixture, insert, ready } from './kit.ts';

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
  '[AC-B1-17a#8] history is RANGE partitioned on first_observed_at with the composite primary key',
  async () => {
    await ready(roles.app);
    const partition = await sql<{ kind: string; key: string }>`
    SELECT relkind::text AS kind, pg_get_partkeydef(oid) AS key FROM pg_class
    WHERE oid = to_regclass('app.price_snapshot')
  `.execute(roles.app);
    expect(partition.rows).toEqual([{ kind: 'p', key: 'RANGE (first_observed_at)' }]);
    const primary = await sql<{ names: string[] }>`
    SELECT ARRAY(
      SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord
    ) AS names FROM pg_constraint c
    WHERE c.conrelid = to_regclass('app.price_snapshot') AND c.contype = 'p'
  `.execute(roles.app);
    expect(primary.rows).toEqual([{ names: ['id', 'first_observed_at'] }]);
    expect(await sqlState(insert(roles.app, fixture({ id: 810001n })))).toBe('ok');
    expect(await sqlState(insert(roles.app, fixture({ id: 810001n })))).toBe('23505');
    expect(
      await sqlState(
        insert(
          roles.app,
          fixture({
            id: 810001n,
            first_observed_at: new Date('2032-07-15T08:00:00Z'),
            last_observed_at: new Date('2032-07-15T08:00:00Z'),
          }),
        ),
      ),
    ).toBe('ok');
  },
  TIMEOUT,
);

it(
  '[AC-B1-17a#10] the latest-row partitioned index starts with app, product, source and descending first observation',
  async () => {
    await ready(roles.app);
    const indexes = await sql<{ names: string[]; descending: boolean }>`
    SELECT ARRAY(
      SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
      LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
      WHERE k.ord <= 4 ORDER BY k.ord
    ) AS names, (i.indoption[3] & 1) = 1 AS descending
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am am ON am.oid = c.relam
    WHERE i.indrelid = to_regclass('app.price_snapshot') AND c.relkind = 'I'
      AND am.amname = 'btree' AND i.indisvalid AND i.indisready
      AND i.indnkeyatts >= 4 AND i.indpred IS NULL AND i.indexprs IS NULL
  `.execute(roles.app);
    expect(indexes.rows).toEqual(
      expect.arrayContaining([
        {
          names: ['app_id', 'product_key', 'source_kind', 'first_observed_at'],
          descending: true,
        },
      ]),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B1-17a#11] maint ensures an idempotent UTC month and first observation routes both boundaries',
  async () => {
    await ready(roles.app);
    expect([...MONTH_PARTITIONED_TABLES]).toContain('price_snapshot');
    const ensured = await roles.maint.transaction().execute(async (trx) => {
      await sql`SET LOCAL TIME ZONE 'Asia/Shanghai'`.execute(trx);
      return ensureMonths(trx, 'price_snapshot', ['2031-03', '2031-03']);
    });
    expect(ensured).toEqual(['price_snapshot_p203103', 'price_snapshot_p203103']);
    const parts = await partitionsOf(roles.app, 'price_snapshot');
    const fallback = parts.filter(({ bound }) => bound === 'DEFAULT');
    expect(fallback).toHaveLength(1);
    expect(parts.filter(({ name }) => name === 'price_snapshot_p203103')).toEqual([
      {
        name: 'price_snapshot_p203103',
        bound: "FOR VALUES FROM ('2031-03-01 00:00:00+00') TO ('2031-04-01 00:00:00+00')",
      },
    ]);
    for (const [at, expected] of [
      ['2031-02-28T23:59:59.999Z', `app.${fallback[0]?.name}`],
      ['2031-03-01T00:00:00Z', 'app.price_snapshot_p203103'],
      ['2031-04-01T07:59:59.999+08:00', 'app.price_snapshot_p203103'],
      ['2031-04-01T08:00:00+08:00', `app.${fallback[0]?.name}`],
    ]) {
      expect(
        await sqlState(
          insert(
            roles.app,
            fixture({
              first_observed_at: at,
              last_observed_at: '2031-05-01T00:00:00Z',
            }),
          ),
        ),
      ).toBe('ok');
      const stored = await sql<{ part: string }>`
      SELECT tableoid::regclass::text AS part FROM app.price_snapshot
      WHERE first_observed_at = ${at}::timestamptz
    `.execute(roles.app);
      expect(stored.rows).toEqual([{ part: expected }]);
    }
  },
  TIMEOUT,
);
