import { MONTH_PARTITIONED_TABLES, createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { dropExpired, ensureMonths, outcome, partitionsOf, sqlState } from '../partitions/kit.ts';
import {
  HASH,
  PAYLOAD,
  SUMMARY,
  TABLE,
  TIMEOUT,
  columns,
  fixture,
  insert,
  requireColumns,
  stored,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
let maint: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 2 });
}, TIMEOUT);

afterAll(async () => {
  if (app) await destroyDb(app);
  if (maint) await destroyDb(maint);
  if (database) await database.drop();
}, TIMEOUT);

it(
  '[AC-B1-04a#7] couli_maint creates an idempotent month partition and fetched_at routes at UTC boundaries',
  async () => {
    await requireColumns(app);
    expect([...MONTH_PARTITIONED_TABLES] as string[]).toContain(TABLE);
    expect(await ensureMonths(maint, TABLE, ['2031-03', '2031-03'])).toEqual([
      'union_raw_payloads_p203103',
      'union_raw_payloads_p203103',
    ]);
    const partitions = await partitionsOf(app, TABLE);
    const fallback = partitions.find(({ bound }) => bound === 'DEFAULT');
    expect(fallback).toBeDefined();
    expect(partitions.find(({ name }) => name === 'union_raw_payloads_p203103')?.bound).toBe(
      "FOR VALUES FROM ('2031-03-01 00:00:00+00') TO ('2031-04-01 00:00:00+00')",
    );
    for (const [at, expected] of [
      ['2031-02-28T23:59:59.999Z', `app.${fallback?.name}`],
      ['2031-03-01T00:00:00.000Z', 'app.union_raw_payloads_p203103'],
      ['2031-04-01T07:59:59.999+08:00', 'app.union_raw_payloads_p203103'],
      ['2031-04-01T08:00:00.000+08:00', `app.${fallback?.name}`],
    ] as const) {
      expect(await sqlState(insert(app, fixture(at))), at).toBe('ok');
      const rows = await stored(app, at);
      expect(rows, at).toHaveLength(1);
      expect(rows[0]?.part, at).toBe(expected);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-04a#8] no retention rule is enabled: old archive partitions and rows survive rejected deletion',
  async () => {
    await requireColumns(app);
    expect(await ensureMonths(maint, TABLE, ['2020-01'])).toEqual(['union_raw_payloads_p202001']);
    const at = '2020-01-15T00:00:00Z';
    expect(await sqlState(insert(app, fixture(at)))).toBe('ok');
    const before = await partitionsOf(app, TABLE);
    const rows = await stored(app, at);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.part).toBe('app.union_raw_payloads_p202001');
    expect(await outcome(dropExpired(maint, TABLE, '2040-01-01T00:00:00Z'))).toMatch(
      /^22023 .*no partition retention rule/,
    );
    expect(await partitionsOf(app, TABLE)).toEqual(before);
    expect(await stored(app, at)).toEqual(rows);
  },
  TIMEOUT,
);

it(
  '[AC-B1-04a#9] couli_app inserts and reads compressed bytes, bigint ids, success and failure metadata',
  async () => {
    await requireColumns(app);
    for (const [kind, errorCode, at] of [
      ['order', null, '2032-07-01T00:00:00Z'],
      ['rights', 'SYNTHETIC_FAILURE', '2032-07-02T00:00:00Z'],
      ['query', null, '2032-07-03T00:00:00Z'],
    ] as const) {
      expect(await sqlState(insert(app, { ...fixture(at), kind, error_code: errorCode }))).toBe(
        'ok',
      );
      const rows = await stored(app, at);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          app_id: 'couli',
          platform: 'taobao',
          kind,
          payload: PAYLOAD,
          fetched_at: new Date(at),
          content_hash: HASH,
          request_summary: SUMMARY,
          latency_ms: 37,
          error_code: errorCode,
        }),
      );
      expect(typeof rows[0]?.id).toBe('bigint');
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-04a#10] app grants allow only INSERT and SELECT; parent and direct partition mutations are denied',
  async () => {
    await requireColumns(app);
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      const grants = await sql<{ allowed: boolean }>`
        SELECT has_table_privilege('couli_app', 'app.union_raw_payloads', ${privilege}) AS allowed
      `.execute(app);
      expect(grants.rows[0]?.allowed, privilege).toBe(['SELECT', 'INSERT'].includes(privilege));
    }
    for (const { name } of await columns(app)) {
      const grants = await sql<{ allowed: boolean }>`
        SELECT has_column_privilege('couli_app', 'app.union_raw_payloads', ${name}, 'UPDATE')
          AS allowed
      `.execute(app);
      expect(grants.rows[0]?.allowed, `column UPDATE: ${name}`).toBe(false);
    }
    expect(await ensureMonths(maint, TABLE, ['2033-05'])).toEqual(['union_raw_payloads_p203305']);
    const times = ['2033-05-15T00:00:00Z', '2034-05-15T00:00:00Z'];
    for (const at of times) expect(await sqlState(insert(app, fixture(at)))).toBe('ok');
    const snapshots = await Promise.all(times.map((at) => stored(app, at)));
    for (const rows of snapshots) expect(rows).toHaveLength(1);
    const children = await partitionsOf(app, TABLE);
    for (const table of [TABLE, ...children.map(({ name }) => name)]) {
      const target = sql.table(`app.${table}`);
      for (const statement of [
        sql`UPDATE ${target} SET kind = 'query'`,
        sql`DELETE FROM ${target}`,
        sql`TRUNCATE TABLE ${target}`,
      ]) {
        expect(await sqlState(statement.execute(app)), table).toBe('42501');
      }
    }
    expect(await Promise.all(times.map((at) => stored(app, at)))).toEqual(snapshots);
  },
  TIMEOUT,
);
