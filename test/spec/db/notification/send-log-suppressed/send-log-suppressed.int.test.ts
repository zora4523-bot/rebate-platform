// B1-12n: BR-WATCH-15 and task supplement B define notify_logs storage only.
// Delivery, inbox writing, preferences, quotas and digests belong to other tasks.
// Check the new column before DML: the unmigrated database must fail assertions.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { sqlState } from '../kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
let readonly: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
});

afterAll(async () => {
  if (app) await destroyDb(app);
  if (readonly) await destroyDb(readonly);
  if (database) await database.drop();
});

const PLANNED = new Date('2026-10-22T08:00:00Z');
const SENT = new Date('2026-10-22T09:00:00Z');
const STATUSES = ['queued', 'success', 'failed', 'suppressed'] as const;
const VALID_STATES = [
  { status: 'queued', suppress_reason: null, sent_at: null },
  { status: 'success', suppress_reason: null, sent_at: SENT },
  { status: 'failed', suppress_reason: null, sent_at: null },
  { status: 'failed', suppress_reason: null, sent_at: SENT },
  { status: 'suppressed', suppress_reason: 'push_disabled', sent_at: null },
] as const;

async function columns() {
  const result = await sql<{ name: string; type: string; nullable: boolean }>`
    SELECT column_name AS name, udt_name AS type, is_nullable = 'YES' AS nullable
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'notify_logs'
    ORDER BY column_name
  `.execute(app);
  return result.rows;
}

async function requireSuppressionColumn(): Promise<void> {
  expect(await columns(), 'notify_logs has its new nullable text column').toContainEqual({
    name: 'suppress_reason',
    type: 'text',
    nullable: true,
  });
}

function log(values: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    app_id: 'couli',
    user_id: null,
    code: 'ORDER_CREDITED',
    channel: 'push',
    dedupe_key: `suppression-${randomUUID()}`,
    planned_at: PLANNED,
    ...values,
  };
}

async function insert(row: Record<string, unknown>) {
  const names = Object.keys(row);
  return sql<Record<string, unknown>>`
    INSERT INTO app.notify_logs (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING *
  `.execute(app);
}

async function update(id: unknown, values: Record<string, unknown>) {
  return sql<Record<string, unknown>>`UPDATE app.notify_logs
    SET ${sql.join(Object.entries(values).map(([name, value]) => sql`${sql.ref(name)} = ${value}`))}
    WHERE id = ${id} RETURNING *
  `.execute(app);
}

async function stored(id: unknown) {
  return (
    await sql<Record<string, unknown>>`SELECT * FROM app.notify_logs
    WHERE id = ${id}`.execute(app)
  ).rows;
}

it('[AC-B1-12n#1] adds only nullable text suppress_reason and keeps existing column shapes', async () => {
  expect(await columns()).toEqual([
    { name: 'app_id', type: 'text', nullable: false },
    { name: 'channel', type: 'text', nullable: false },
    { name: 'code', type: 'text', nullable: false },
    { name: 'created_at', type: 'timestamptz', nullable: false },
    { name: 'dedupe_key', type: 'text', nullable: false },
    { name: 'id', type: 'uuid', nullable: false },
    { name: 'planned_at', type: 'timestamptz', nullable: false },
    { name: 'row_version', type: 'int4', nullable: false },
    { name: 'sent_at', type: 'timestamptz', nullable: true },
    { name: 'status', type: 'text', nullable: false },
    { name: 'suppress_reason', type: 'text', nullable: true },
    { name: 'updated_at', type: 'timestamptz', nullable: false },
    { name: 'user_id', type: 'uuid', nullable: true },
  ]);
});

it('[AC-B1-12n#2] couli_app inserts and reads all four statuses; old inserts still default to queued', async () => {
  await requireSuppressionColumn();
  for (const state of VALID_STATES) {
    const row = log(state);
    const result = await insert(row);
    expect(result.rows).toEqual([expect.objectContaining(row)]);
    expect(await stored(row['id'])).toEqual(result.rows);
  }
  const legacy = await insert(log());
  expect(legacy.rows).toEqual([
    expect.objectContaining({
      status: 'queued',
      suppress_reason: null,
      sent_at: null,
      row_version: 0,
    }),
  ]);
  for (const status of ['success', 'failed']) {
    const row = log({ status, sent_at: SENT });
    expect((await insert(row)).rows).toEqual([
      expect.objectContaining({ ...row, suppress_reason: null }),
    ]);
  }
});

it('[AC-B1-12n#3] rejects unknown statuses with 23514 on INSERT and UPDATE', async () => {
  await requireSuppressionColumn();
  const original = log();
  const saved = (await insert(original)).rows;
  for (const status of ['', 'pending', 'sent', 'SUPPRESSED', 'suppressed ', 'other']) {
    for (const suppress_reason of [null, 'push_disabled']) {
      const state = { status, suppress_reason };
      expect(await sqlState(insert(log(state))), JSON.stringify(state)).toBe('23514');
      expect(await sqlState(update(original['id'], state)), JSON.stringify(state)).toBe('23514');
      expect(await stored(original['id'])).toEqual(saved);
    }
  }
});

it('[AC-B1-12n#4] only push_disabled is accepted as a non-null reason, including updates', async () => {
  await requireSuppressionColumn();
  const original = log({ status: 'suppressed', suppress_reason: 'push_disabled' });
  const saved = (await insert(original)).rows;
  for (const suppress_reason of [
    '',
    ' ',
    'PUSH_DISABLED',
    'push_disabled ',
    ' push_disabled',
    'daily_push_cap',
    'stale_alert_suppressed',
    'other',
  ]) {
    expect(
      await sqlState(insert(log({ status: 'suppressed', suppress_reason }))),
      suppress_reason,
    ).toBe('23514');
    expect(await sqlState(update(original['id'], { suppress_reason })), suppress_reason).toBe(
      '23514',
    );
    expect(await stored(original['id'])).toEqual(saved);
  }
});

it('[AC-B1-12n#5] INSERT enforces the full status/reason/sent_at truth table, including SQL NULL', async () => {
  await requireSuppressionColumn();
  for (const status of STATUSES) {
    for (const suppress_reason of [null, 'push_disabled']) {
      for (const sent_at of [null, SENT]) {
        const state = { status, suppress_reason, sent_at };
        const valid = VALID_STATES.some(
          (candidate) =>
            candidate.status === status &&
            candidate.suppress_reason === suppress_reason &&
            candidate.sent_at === sent_at,
        );
        expect(await sqlState(insert(log(state))), JSON.stringify(state)).toBe(
          valid ? 'no error' : '23514',
        );
      }
    }
  }
  expect(await sqlState(insert(log({ status: 'suppressed' })))).toBe('23514');
});

it('[AC-B1-12n#6] UPDATE applies the same truth table from every valid state and preserves rejected rows', async () => {
  await requireSuppressionColumn();
  for (const origin of VALID_STATES) {
    const row = log(origin);
    const saved = (await insert(row)).rows;
    for (const status of STATUSES) {
      for (const suppress_reason of [null, 'push_disabled']) {
        for (const sent_at of [null, SENT]) {
          const target = { status, suppress_reason, sent_at };
          const valid = VALID_STATES.some(
            (candidate) =>
              candidate.status === status &&
              candidate.suppress_reason === suppress_reason &&
              candidate.sent_at === sent_at,
          );
          expect(
            await sqlState(update(row['id'], target)),
            JSON.stringify({ origin, target }),
          ).toBe(valid ? 'no error' : '23514');
          if (valid) {
            expect(await stored(row['id'])).toEqual([
              expect.objectContaining({ ...row, ...target }),
            ]);
            expect(await sqlState(update(row['id'], origin))).toBe('no error');
          }
          expect(await stored(row['id'])).toEqual(saved);
        }
      }
    }
  }
});

it('[AC-B1-12n#7] changing just status, reason or sent_at cannot leave inconsistent suppression', async () => {
  await requireSuppressionColumn();
  const row = log();
  await insert(row);
  expect(await sqlState(update(row['id'], { suppress_reason: 'push_disabled' }))).toBe('23514');
  expect(await sqlState(update(row['id'], { status: 'suppressed' }))).toBe('23514');
  const suppressed = await update(row['id'], {
    status: 'suppressed',
    suppress_reason: 'push_disabled',
  });
  expect(suppressed.rows).toEqual([
    expect.objectContaining({
      status: 'suppressed',
      suppress_reason: 'push_disabled',
      sent_at: null,
    }),
  ]);
  for (const change of [{ suppress_reason: null }, { status: 'queued' }, { sent_at: SENT }]) {
    expect(await sqlState(update(row['id'], change))).toBe('23514');
    expect(await stored(row['id'])).toEqual(suppressed.rows);
  }
  expect((await update(row['id'], { status: 'queued', suppress_reason: null })).rows).toEqual([
    expect.objectContaining({ status: 'queued', suppress_reason: null, sent_at: null }),
  ]);
});

it('[AC-B1-12n#8] suppressed logs share the existing app/dedupe unique key across statuses', async () => {
  await requireSuppressionColumn();
  for (const state of VALID_STATES) {
    const key = `dedupe-${randomUUID()}`;
    const suppressed = log({
      dedupe_key: key,
      status: 'suppressed',
      suppress_reason: 'push_disabled',
    });
    await insert(suppressed);
    expect(
      await sqlState(
        insert(log({ ...state, dedupe_key: key, channel: 'sms', code: 'OTHER_NOTICE' })),
      ),
    ).toBe('23505');
    expect(await sqlState(insert(log({ ...state, dedupe_key: key, app_id: 'couli_two' })))).toBe(
      'no error',
    );
    const other = log(state);
    await insert(other);
    expect(await sqlState(update(other['id'], { dedupe_key: key }))).toBe('23505');
    // Existing queued/success/failed rows also block a new suppressed delivery.
    expect(
      await sqlState(
        insert(
          log({
            dedupe_key: other['dedupe_key'],
            status: 'suppressed',
            suppress_reason: 'push_disabled',
          }),
        ),
      ),
    ).toBe('23505');
  }
  const key = `concurrent-${randomUUID()}`;
  const outcomes = await Promise.all([
    sqlState(
      insert(log({ dedupe_key: key, status: 'suppressed', suppress_reason: 'push_disabled' })),
    ),
    sqlState(insert(log({ dedupe_key: key }))),
  ]);
  expect(outcomes.sort()).toEqual(['23505', 'no error']);
  const count = await sql<{ count: number }>`SELECT count(*)::integer AS count
    FROM app.notify_logs WHERE app_id = 'couli' AND dedupe_key = ${key}`.execute(app);
  expect(count.rows).toEqual([{ count: 1 }]);
});

it('[AC-B1-12n#9] existing scan indexes remain valid and nonpartial', async () => {
  await requireSuppressionColumn();
  const result = await sql<{ name: string; columns: string[]; valid: boolean; partial: boolean }>`
    SELECT i.relname AS name, x.indisvalid AND x.indisready AS valid,
      x.indpred IS NOT NULL AS partial,
      ARRAY(SELECT a.attname::text FROM unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        WHERE k.ord <= x.indnkeyatts ORDER BY k.ord) AS columns
    FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_class i ON i.oid = x.indexrelid
    WHERE n.nspname = 'app' AND t.relname = 'notify_logs'
  `.execute(app);
  expect(result.rows).toEqual(
    expect.arrayContaining([
      {
        name: 'notify_logs_due_idx',
        columns: ['status', 'planned_at'],
        valid: true,
        partial: false,
      },
      {
        name: 'notify_logs_user_created_idx',
        columns: ['app_id', 'user_id', 'created_at'],
        valid: true,
        partial: false,
      },
    ]),
  );
});

it('[AC-B1-12n#10] the new column inherits existing grants without granting readonly writes', async () => {
  await requireSuppressionColumn();
  for (const role of ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint']) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      const result = await sql<{ allowed: boolean }>`SELECT
        has_table_privilege(${role}, 'app.notify_logs', ${privilege}) AS allowed`.execute(app);
      const allowed =
        role === 'couli_app'
          ? ['SELECT', 'INSERT', 'UPDATE'].includes(privilege)
          : role === 'couli_readonly' && privilege === 'SELECT';
      expect(result.rows, `${role} ${privilege}`).toEqual([{ allowed }]);
      if (['SELECT', 'INSERT', 'UPDATE'].includes(privilege)) {
        const column = await sql<{ allowed: boolean }>`SELECT
          has_column_privilege(${role}, 'app.notify_logs', 'suppress_reason', ${privilege}) AS allowed`.execute(
          app,
        );
        expect(column.rows, `${role} suppress_reason ${privilege}`).toEqual([{ allowed }]);
      }
    }
  }
  const row = log({ status: 'suppressed', suppress_reason: 'push_disabled' });
  await insert(row);
  const read = await sql`SELECT status, suppress_reason, sent_at FROM app.notify_logs
    WHERE id = ${row['id']}`.execute(readonly);
  expect(read.rows).toEqual([
    { status: 'suppressed', suppress_reason: 'push_disabled', sent_at: null },
  ]);
  expect(
    await sqlState(
      sql`UPDATE app.notify_logs SET suppress_reason = 'push_disabled'
    WHERE id = ${row['id']}`.execute(readonly),
    ),
  ).toBe('42501');
});
