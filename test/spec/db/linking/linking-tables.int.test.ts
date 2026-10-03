// Rule tests for the linking tables of B1-06a (规划/04 §3.2 rows links, link_logs,
// link_open_attempts; ADR-0001 §4.2 #5 partition granularity; 08 BR-PRICE-12, BR-ATTR-14,
// BR-ATTR-21 细则「待跟单卡按实际外跳选」「待跟单卡的完成与关闭按尝试」). Real PostgreSQL as
// couli_app (the linking module writes these tables). Columns whose shape 04 leaves to the
// implementation are filled from the catalog by kit.ts. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  CHECK_VIOLATION,
  UNIQUE_VIOLATION,
  columns,
  insertRow,
  newLink,
  newUser,
  sqlState,
  useDb,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  useDb(app);
});

afterAll(async () => {
  await destroyDb(app);
  await database.drop();
});

const OPENED = new Date('2026-10-04T08:00:00Z');

async function newAttempt(values: Record<string, unknown> = {}): Promise<string> {
  const attemptId = randomUUID();
  await insertRow('link_open_attempts', {
    attempt_id: attemptId,
    app_id: 'couli',
    link_id: await newLink(),
    user_id: await newUser(),
    opened_at: OPENED,
    ...values,
  });
  return attemptId;
}

// ---------------------------------------------------------------------------------------------
// links (04 §3.2 links; BR-PRICE-12)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-06a#1] link_id is unique across all links', async () => {
  const linkId = await newLink();
  expect(await sqlState(newLink({ link_id: linkId }))).toBe(UNIQUE_VIOLATION);
});

it('[AC-B1-06a#2] links keep no per-attempt columns (jump_reported_at, track_dismissed_at)', async () => {
  const names = (await columns('links')).map((c) => c.name);
  expect(names).not.toContain('jump_reported_at');
  expect(names).not.toContain('track_dismissed_at');
  expect(names).not.toContain('preconvert_final_price_fen');
  expect(names).toContain('link_id');
  expect(names).toContain('quoted_final_price_fen');
});

it('[AC-B1-06a#3] amounts of links and link_logs are bigint fen', async () => {
  const types = new Map<string, string>();
  for (const table of ['links', 'link_logs']) {
    for (const c of await columns(table)) types.set(`${table}.${c.name}`, c.type);
  }
  for (const name of [
    'links.quoted_final_price_fen',
    'links.quoted_coupon_fen',
    'link_logs.quoted_price_fen',
  ]) {
    expect(types.get(name), name).toBe('int8');
  }
});

it('[AC-B1-06a#4] the quote snapshot of a link cannot be changed once written (BR-PRICE-12)', async () => {
  const linkId = await newLink({
    quoted_final_price_fen: 2990,
    quoted_coupon_fen: 500,
    quoted_coupon_id: 'coupon-one',
    quoted_at: new Date('2026-10-04T07:59:00Z'),
  });
  for (const change of [
    sql`UPDATE app.links SET quoted_coupon_id = 'coupon-two' WHERE link_id = ${linkId}`,
    sql`UPDATE app.links SET quoted_final_price_fen = 2890 WHERE link_id = ${linkId}`,
    sql`UPDATE app.links SET quoted_coupon_fen = 600 WHERE link_id = ${linkId}`,
    sql`UPDATE app.links SET quoted_at = ${new Date('2026-10-04T08:30:00Z')} WHERE link_id = ${linkId}`,
  ]) {
    expect(await sqlState(change.execute(app))).not.toBe('no error');
  }
  const stored = await sql<{ price: string; coupon: string; coupon_id: string }>`
    SELECT quoted_final_price_fen::text AS price, quoted_coupon_fen::text AS coupon,
           quoted_coupon_id::text AS coupon_id
    FROM app.links WHERE link_id = ${linkId}
  `.execute(app);
  expect(stored.rows).toEqual([{ price: '2990', coupon: '500', coupon_id: 'coupon-one' }]);
});

// ---------------------------------------------------------------------------------------------
// link_logs (04 §3.2 link_logs; ADR-0001 §4.2 #5: link_logs is partitioned by day)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-06a#5] link_logs is range-partitioned on created_at with a DEFAULT partition', async () => {
  const parent = await sql<{ kind: string; key: string }>`
    SELECT c.relkind::text AS kind, pg_get_partkeydef(c.oid) AS key
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = 'link_logs'
  `.execute(app);
  expect(parent.rows).toEqual([{ kind: 'p', key: 'RANGE (created_at)' }]);
  const defaults = await sql<{ n: string }>`
    SELECT count(*)::text AS n
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'app' AND p.relname = 'link_logs'
      AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'
  `.execute(app);
  expect(defaults.rows).toEqual([{ n: '1' }]);
});

it('[AC-B1-06a#6] link_logs.event is convert, precompute, register or open', async () => {
  for (const event of ['convert', 'precompute', 'register', 'open']) {
    expect(
      await sqlState(insertRow('link_logs', { app_id: 'couli', link_id: await newLink(), event })),
      event,
    ).toBe('no error');
  }
  for (const event of ['jump', 'OPEN', '']) {
    expect(
      await sqlState(insertRow('link_logs', { app_id: 'couli', link_id: await newLink(), event })),
      JSON.stringify(event),
    ).toBe(CHECK_VIOLATION);
  }
});

// ---------------------------------------------------------------------------------------------
// link_open_attempts (04 §3.2 link_open_attempts; BR-ATTR-21 细则)
// ---------------------------------------------------------------------------------------------

it('[AC-B1-06a#7] an attempt id is issued once', async () => {
  const attemptId = await newAttempt();
  expect(await sqlState(newAttempt({ attempt_id: attemptId }))).toBe(UNIQUE_VIOLATION);
});

it('[AC-B1-06a#8] an anonymous open of a shared link has no user', async () => {
  expect(await sqlState(newAttempt({ user_id: null }))).toBe('no error');
  const cols = new Map((await columns('link_open_attempts')).map((c) => [c.name, c]));
  expect(cols.get('user_id')?.nullable).toBe(true);
  expect(cols.get('app_id')?.nullable).toBe(false);
  expect(cols.get('link_id')?.nullable).toBe(false);
  expect(cols.get('opened_at')?.nullable).toBe(false);
  expect(cols.get('jump_reported_at')?.nullable).toBe(true);
  expect(cols.get('dismissed_at')?.nullable).toBe(true);
});

it('[AC-B1-06a#9] attempts are indexed by (app_id, user_id, opened_at)', async () => {
  const rows = await sql<{ def: string }>`
    SELECT indexdef AS def FROM pg_indexes
    WHERE schemaname = 'app' AND tablename = 'link_open_attempts'
  `.execute(app);
  expect(
    rows.rows.some(({ def }) => /\(\s*app_id\s*,\s*user_id\s*,\s*opened_at\b/.test(def)),
    JSON.stringify(rows.rows),
  ).toBe(true);
});

for (const column of ['jump_reported_at', 'dismissed_at'] as const) {
  it(`[AC-B1-06a#${column === 'jump_reported_at' ? '10' : '11'}] ${column} is written once and never changed or cleared`, async () => {
    expect((await columns('link_open_attempts')).find((c) => c.name === column)?.type).toBe(
      'timestamptz',
    );
    const attemptId = await newAttempt();
    const first = new Date('2026-10-04T08:00:05Z');
    expect(
      await sqlState(
        sql`UPDATE app.link_open_attempts SET ${sql.ref(column)} = ${first}
            WHERE attempt_id = ${attemptId}`.execute(app),
      ),
    ).toBe('no error');
    expect(
      await sqlState(
        sql`UPDATE app.link_open_attempts SET ${sql.ref(column)} = ${new Date('2026-10-04T08:09:00Z')}
            WHERE attempt_id = ${attemptId}`.execute(app),
      ),
    ).not.toBe('no error');
    expect(
      await sqlState(
        sql`UPDATE app.link_open_attempts SET ${sql.ref(column)} = NULL
            WHERE attempt_id = ${attemptId}`.execute(app),
      ),
    ).not.toBe('no error');
    const stored = await sql<{ same: boolean | null }>`
      SELECT ${sql.ref(column)} = ${first}::timestamptz AS same
      FROM app.link_open_attempts WHERE attempt_id = ${attemptId}
    `.execute(app);
    expect(stored.rows).toEqual([{ same: true }]);
  });
}

it('[AC-B1-06a#13] the jump report and the dismissal of one attempt are written independently, in either order', async () => {
  for (const order of [
    ['jump_reported_at', 'dismissed_at'],
    ['dismissed_at', 'jump_reported_at'],
  ] as const) {
    const attemptId = await newAttempt();
    for (const column of order) {
      expect(
        await sqlState(
          sql`UPDATE app.link_open_attempts SET ${sql.ref(column)} = ${new Date('2026-10-04T08:01:00Z')}
              WHERE attempt_id = ${attemptId}`.execute(app),
        ),
        `${order.join(' then ')}: ${column}`,
      ).toBe('no error');
    }
    const stored = await sql<{ both: boolean }>`
      SELECT jump_reported_at IS NOT NULL AND dismissed_at IS NOT NULL AS both
      FROM app.link_open_attempts WHERE attempt_id = ${attemptId}
    `.execute(app);
    expect(stored.rows).toEqual([{ both: true }]);
  }
});

it('[AC-B1-06a#12] the attempt keeps its link, user and open time', async () => {
  const attemptId = await newAttempt();
  for (const change of [
    sql`UPDATE app.link_open_attempts SET link_id = ${await newLink()} WHERE attempt_id = ${attemptId}`,
    sql`UPDATE app.link_open_attempts SET user_id = ${await newUser()} WHERE attempt_id = ${attemptId}`,
    sql`UPDATE app.link_open_attempts SET opened_at = ${new Date('2026-10-01T00:00:00Z')}
        WHERE attempt_id = ${attemptId}`,
  ]) {
    expect(await sqlState(change.execute(app))).not.toBe('no error');
  }
});
