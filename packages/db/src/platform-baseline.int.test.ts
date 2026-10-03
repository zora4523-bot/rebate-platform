// Integration tests for the platform baseline migration: real PostgreSQL, real roles.
// Every connection is made as a business role, so grants and triggers are exercised for real.
import { randomUUID } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDb,
  destroyDb,
  MONTH_PARTITIONED_TABLES,
  monthPartitionName,
  monthStartDate,
  type DB,
} from './index.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';

const PERMISSION_DENIED = '42501';
const UNIQUE_VIOLATION = '23505';

/** Resolves to the SQLSTATE of the rejection, or 'no error' when the promise resolves. */
async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'no error';
  } catch (error) {
    return error instanceof pg.DatabaseError
      ? (error.code ?? 'no code')
      : `not pg: ${String(error)}`;
  }
}

async function ensurePartition(db: Kysely<DB>, table: string, month: Date): Promise<string> {
  const result = await sql<{ name: string }>`
    SELECT app.ensure_month_partition(${table}, ${monthStartDate(month)}::date) AS name
  `.execute(db);
  return result.rows[0]?.name ?? '';
}

async function partitionBound(db: Kysely<DB>, partition: string): Promise<string> {
  const result = await sql<{ bound: string }>`
    SELECT pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = ${partition}
  `.execute(db);
  return result.rows[0]?.bound ?? '';
}

describe('platform baseline as business roles', () => {
  let database: TestDatabase;
  let app: Kysely<DB>;
  let maint: Kysely<DB>;
  let payout: Kysely<DB>;
  let readonly: Kysely<DB>;

  const october = new Date('2026-10-01T00:00:00Z');

  beforeAll(async () => {
    database = await createTestDatabase();
    app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
    maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 1 });
    payout = createDb({ connectionString: database.urlFor('couli_payout'), max: 1 });
    readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  });

  afterAll(async () => {
    await Promise.all([app, maint, payout, readonly].map((db) => destroyDb(db)));
    await database.drop();
  });

  it('test workers do not see the superuser URL and connect as the requested role', async () => {
    expect(process.env['TEST_PG_ADMIN_URL']).toBeUndefined();
    const who = await sql<{ current_user: string; is_superuser: string }>`
      SELECT current_user, current_setting('is_superuser') AS is_superuser
    `.execute(app);
    expect(who.rows[0]).toEqual({ current_user: 'couli_app', is_superuser: 'off' });
  });

  it('int8 and int8[] values come back as BigInt, exact beyond 2^53', async () => {
    const result = await sql<{ one: bigint; many: (bigint | null)[] }>`
      SELECT 9007199254740993::int8 AS one, ARRAY[1, NULL, 9007199254740993]::int8[] AS many
    `.execute(app);
    expect(result.rows[0]).toEqual({
      one: 9007199254740993n,
      many: [1n, null, 9007199254740993n],
    });
  });

  it('couli_maint creates month partitions through the SECURITY DEFINER function, idempotently', async () => {
    for (const table of MONTH_PARTITIONED_TABLES) {
      const expected = monthPartitionName(table, october);
      expect(await ensurePartition(maint, table, october)).toBe(expected);
      expect(await ensurePartition(maint, table, new Date('2026-10-31T23:59:59.999Z'))).toBe(
        expected,
      );
      expect(await partitionBound(maint, expected)).toBe(
        "FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00')",
      );
    }
  });

  it('couli_maint cannot use the function for tables outside the allow-list', async () => {
    expect(await sqlState(ensurePartition(maint, 'idempotency_keys', october))).toBe('22023');
    expect(await sqlState(ensurePartition(maint, 'pg_class', october))).toBe('22023');
  });

  it('couli_app inserts into event_log and the row lands in the month partition', async () => {
    const inserted = await app
      .insertInto('event_log')
      .values({
        app_id: 'couli',
        event_id: randomUUID(),
        name: 'order.created',
        payload: JSON.stringify({ amount_fen: 1 }),
        occurred_at: new Date('2026-10-15T08:00:00+08:00'),
      })
      .returning(['id', sql<string>`tableoid::regclass::text`.as('partition')])
      .executeTakeFirstOrThrow();
    expect(inserted.partition).toBe('app.event_log_p202610');
    // int8 comes back as BigInt (ADR-0001 §4.2 #3).
    expect(typeof inserted.id).toBe('bigint');
  });

  it('rows of a month without a partition fall into the DEFAULT partition', async () => {
    const inserted = await app
      .insertInto('event_log')
      .values({
        app_id: 'couli',
        event_id: randomUUID(),
        name: 'order.created',
        payload: JSON.stringify({}),
        occurred_at: new Date('2031-01-01T00:00:00Z'),
      })
      .returning(sql<string>`tableoid::regclass::text`.as('partition'))
      .executeTakeFirstOrThrow();
    expect(inserted.partition).toBe('app.event_log_default');
  });

  it('a month whose rows already sit in the DEFAULT partition cannot get its partition', async () => {
    // ADR-0001 §4.2 #4: the rows have to be moved out first; PostgreSQL reports a check violation.
    expect(
      await sqlState(ensurePartition(maint, 'event_log', new Date('2031-01-01T00:00:00Z'))),
    ).toBe('23514');
  });

  it('couli_app cannot UPDATE or DELETE event_log', async () => {
    expect(await sqlState(sql`UPDATE app.event_log SET name = 'tampered'`.execute(app))).toBe(
      PERMISSION_DENIED,
    );
    expect(await sqlState(sql`DELETE FROM app.event_log`.execute(app))).toBe(PERMISSION_DENIED);
    expect(await sqlState(sql`TRUNCATE app.event_log`.execute(app))).toBe(PERMISSION_DENIED);
    const count = await app
      .selectFrom('event_log')
      .select(sql<bigint>`count(*)`.as('n'))
      .executeTakeFirstOrThrow();
    expect(count.n).toBe(2n);
  });

  it('the append-only trigger is present on event_log and on every partition', async () => {
    const result = await sql<{ relname: string }>`
      SELECT c.relname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND t.tgname = 'event_log_append_only' AND t.tgenabled = 'O'
      ORDER BY c.relname
    `.execute(app);
    expect(result.rows.map((row) => row.relname)).toEqual([
      'event_log',
      'event_log_default',
      'event_log_p202610',
    ]);
  });

  it('couli_app cannot run DDL in schema app or call the partition function', async () => {
    expect(await sqlState(sql`CREATE TABLE app.sneaky (id int)`.execute(app))).toBe(
      PERMISSION_DENIED,
    );
    expect(
      await sqlState(
        sql`CREATE TABLE app.event_log_p209901 PARTITION OF app.event_log
            FOR VALUES FROM ('2099-01-01 00:00:00+00') TO ('2099-02-01 00:00:00+00')`.execute(app),
      ),
    ).toBe(PERMISSION_DENIED);
    expect(await sqlState(ensurePartition(app, 'event_log', october))).toBe(PERMISSION_DENIED);
    expect(await sqlState(sql`DROP TABLE app.event_log_default`.execute(app))).toBe(
      PERMISSION_DENIED,
    );
  });

  it('couli_maint has no table access and no DDL of its own', async () => {
    expect(await sqlState(sql`SELECT 1 FROM app.event_log`.execute(maint))).toBe(PERMISSION_DENIED);
    expect(await sqlState(sql`CREATE TABLE app.sneaky (id int)`.execute(maint))).toBe(
      PERMISSION_DENIED,
    );
  });

  it('a duplicate processed_events key raises a unique violation', async () => {
    const eventId = randomUUID();
    await app
      .insertInto('processed_events')
      .values({ consumer: 'notify', event_id: eventId })
      .execute();
    expect(
      await sqlState(
        app
          .insertInto('processed_events')
          .values({ consumer: 'notify', event_id: eventId })
          .execute(),
      ),
    ).toBe(UNIQUE_VIOLATION);
    // The same event for another consumer is a different key.
    await app
      .insertInto('processed_events')
      .values({ consumer: 'risk', event_id: eventId })
      .execute();
    const rows = await app
      .selectFrom('processed_events')
      .select('consumer')
      .where('event_id', '=', eventId)
      .orderBy('consumer')
      .execute();
    expect(rows.map((row) => row.consumer)).toEqual(['notify', 'risk']);
  });

  it('idempotency_keys enforces its scope key and couli_app may update and delete rows', async () => {
    const row = {
      app_id: 'couli',
      subject: 'u:0199a1b2-0000-7000-8000-000000000001',
      method: 'POST',
      path: '/v1/withdrawals',
      key: 'k-1',
      request_hash: 'sha256:abc',
      status: 'processing',
      expire_at: new Date('2026-10-02T00:00:00Z'),
    };
    await app.insertInto('idempotency_keys').values(row).execute();
    expect(await sqlState(app.insertInto('idempotency_keys').values(row).execute())).toBe(
      UNIQUE_VIOLATION,
    );
    const updated = await app
      .updateTable('idempotency_keys')
      .set({ status: 'completed', response: JSON.stringify({ ok: true }) })
      .where('key', '=', 'k-1')
      .executeTakeFirstOrThrow();
    expect(updated.numUpdatedRows).toBe(1n);
    const deleted = await app
      .deleteFrom('idempotency_keys')
      .where('key', '=', 'k-1')
      .executeTakeFirstOrThrow();
    expect(deleted.numDeletedRows).toBe(1n);
  });

  it('couli_payout writes event_log and processed_events but not idempotency_keys', async () => {
    await payout
      .insertInto('event_log')
      .values({
        app_id: 'couli',
        event_id: randomUUID(),
        name: 'wallet.withdrawal_changed',
        payload: JSON.stringify({}),
        occurred_at: new Date('2026-10-20T00:00:00Z'),
      })
      .execute();
    await payout
      .insertInto('processed_events')
      .values({ consumer: 'payout', event_id: randomUUID() })
      .execute();
    expect(await sqlState(payout.selectFrom('idempotency_keys').selectAll().execute())).toBe(
      PERMISSION_DENIED,
    );
    expect(await sqlState(sql`DELETE FROM app.processed_events`.execute(payout))).toBe(
      PERMISSION_DENIED,
    );
  });

  it('couli_readonly reads the three tables and cannot write', async () => {
    const events = await readonly.selectFrom('event_log').select('name').execute();
    expect(events.length).toBeGreaterThan(0);
    await readonly.selectFrom('processed_events').selectAll().execute();
    await readonly.selectFrom('idempotency_keys').selectAll().execute();
    expect(
      await sqlState(
        readonly
          .insertInto('processed_events')
          .values({ consumer: 'x', event_id: randomUUID() })
          .execute(),
      ),
    ).toBe(PERMISSION_DENIED);
  });
});

describe('partition bounds do not depend on the session time zone', () => {
  const zones = ['UTC', 'America/Los_Angeles'] as const;
  // Includes both US daylight-saving switches and a year end.
  const months = ['2026-11-01', '2026-12-01', '2027-03-01'].map((d) => new Date(`${d}T00:00:00Z`));
  const databases: TestDatabase[] = [];

  afterAll(async () => {
    await Promise.all(databases.map((database) => database.drop()));
  });

  async function boundsCreatedUnder(zone: string): Promise<string[]> {
    const database = await createTestDatabase();
    databases.push(database);
    const client = new pg.Client({ connectionString: database.urlFor('couli_maint') });
    await client.connect();
    try {
      await client.query(`SET TimeZone = '${zone}'`);
      const bounds: string[] = [];
      for (const month of months) {
        const created = await client.query<{ name: string }>(
          'SELECT app.ensure_month_partition($1, $2::date) AS name',
          ['event_log', monthStartDate(month)],
        );
        const name = created.rows[0]?.name ?? '';
        // Render the bound in UTC so both databases are compared in the same notation.
        await client.query("SET TimeZone = 'UTC'");
        const bound = await client.query<{ bound: string }>(
          `SELECT pg_get_expr(c.relpartbound, c.oid) AS bound
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'app' AND c.relname = $1`,
          [name],
        );
        bounds.push(`${name} ${bound.rows[0]?.bound ?? ''}`);
        await client.query(`SET TimeZone = '${zone}'`);
      }
      return bounds;
    } finally {
      await client.end();
    }
  }

  it('creates identical UTC month bounds under UTC and America/Los_Angeles', async () => {
    const [utc, losAngeles] = await Promise.all(zones.map((zone) => boundsCreatedUnder(zone)));
    expect(utc).toEqual([
      "event_log_p202611 FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00')",
      "event_log_p202612 FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00')",
      "event_log_p202703 FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00')",
    ]);
    expect(losAngeles).toEqual(utc);
  });

  it('routes the last millisecond of a month and the first instant of the next correctly', async () => {
    const database = databases[1];
    if (database === undefined) {
      throw new Error('the bounds test must run first');
    }
    const app = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
    try {
      // Session time zone of the writer differs from UTC on purpose.
      await sql`SET TimeZone = 'America/Los_Angeles'`.execute(app);
      const partitions: string[] = [];
      for (const instant of ['2026-11-30T23:59:59.999Z', '2026-12-01T00:00:00.000Z']) {
        const row = await app
          .insertInto('event_log')
          .values({
            app_id: 'couli',
            event_id: randomUUID(),
            name: 'order.created',
            payload: JSON.stringify({}),
            occurred_at: new Date(instant),
          })
          .returning(sql<string>`tableoid::regclass::text`.as('partition'))
          .executeTakeFirstOrThrow();
        partitions.push(row.partition);
      }
      expect(partitions).toEqual(['app.event_log_p202611', 'app.event_log_p202612']);
    } finally {
      await destroyDb(app);
    }
  });
});
