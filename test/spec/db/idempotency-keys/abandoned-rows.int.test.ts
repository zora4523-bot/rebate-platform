// Rule tests for idempotency_keys after CT-16b (规划/04 §3.2 idempotency_keys row; §5「幂等」;
// 08 BR-ID-10 细则「敏感操作的幂等键」): an abandoned row has neither request_hash nor response,
// every other row has a request_hash, status is one of processing / completed / abandoned, and
// the unique scope key keeps a later business write from landing on an abandoned key (the
// business write rolls back as a whole). Real PostgreSQL, connected as the business role
// couli_app (the abandon endpoint and the idempotency middleware both run as it).
// Top-level it() only (规划/11 §4.3).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';
const UNIQUE_VIOLATION = '23505';

let database: TestDatabase;
let app: Kysely<DB>;
let seq = 0;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});

afterAll(async () => {
  await destroyDb(app);
  await database.drop();
});

/** Resolves to the SQLSTATE of the rejection, or 'no error' when the statement succeeds. */
async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'no error';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : `not a database error: ${String(error)}`;
  }
}

type Row = {
  key: string;
  status: string;
  request_hash: string | null;
  response: string | null;
  path?: string;
};

/** A fresh key per call so that the tests never collide on the unique scope key. */
function freshKey(): string {
  seq += 1;
  return `rule-test-key-${String(seq)}`;
}

function insert(row: Row): Promise<unknown> {
  return sql`
    INSERT INTO app.idempotency_keys
      (app_id, subject, user_id, method, path, key, request_hash, status, response, expire_at)
    VALUES (
      'couli', 'u:0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a61', '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a61',
      'POST', ${row.path ?? '/v1/withdrawals'}, ${row.key}, ${row.request_hash}, ${row.status},
      ${row.response}::jsonb, now() + interval '30 days'
    )
  `.execute(app);
}

const HASH = 'a'.repeat(64);
const STORED = JSON.stringify({ code: 0, msg: '', data: { withdrawal_id: 'w-1' } });

it('[AC-CT-16b#1] an abandoned row without request_hash and response can be inserted', async () => {
  const key = freshKey();
  expect(
    await sqlState(insert({ key, status: 'abandoned', request_hash: null, response: null })),
  ).toBe('no error');
  const stored = await sql<{ status: string; request_hash: string | null; response: unknown }>`
    SELECT status, request_hash, response FROM app.idempotency_keys WHERE key = ${key}
  `.execute(app);
  expect(stored.rows).toEqual([{ status: 'abandoned', request_hash: null, response: null }]);
});

it('[AC-CT-16b#2] an abandoned row with a request_hash is rejected', async () => {
  expect(
    await sqlState(
      insert({ key: freshKey(), status: 'abandoned', request_hash: HASH, response: null }),
    ),
  ).toBe(CHECK_VIOLATION);
});

it('[AC-CT-16b#3] an abandoned row with a response is rejected', async () => {
  expect(
    await sqlState(
      insert({ key: freshKey(), status: 'abandoned', request_hash: null, response: STORED }),
    ),
  ).toBe(CHECK_VIOLATION);
  expect(
    await sqlState(
      insert({ key: freshKey(), status: 'abandoned', request_hash: HASH, response: STORED }),
    ),
  ).toBe(CHECK_VIOLATION);
});

it('[AC-CT-16b#4] processing and completed rows still need a request_hash', async () => {
  for (const status of ['processing', 'completed']) {
    const response = status === 'completed' ? STORED : null;
    const state = await sqlState(insert({ key: freshKey(), status, request_hash: null, response }));
    // Either the CHECK or a NOT NULL kept from 0003 may reject it; both are database refusals.
    expect([CHECK_VIOLATION, NOT_NULL_VIOLATION], status).toContain(state);
  }
});

it('[AC-CT-16b#5] processing and completed rows with a request_hash are accepted', async () => {
  expect(
    await sqlState(
      insert({ key: freshKey(), status: 'processing', request_hash: HASH, response: null }),
    ),
  ).toBe('no error');
  expect(
    await sqlState(
      insert({ key: freshKey(), status: 'completed', request_hash: HASH, response: STORED }),
    ),
  ).toBe('no error');
});

it('[AC-CT-16b#6] a status outside processing / completed / abandoned is rejected', async () => {
  for (const status of ['done', 'failed', 'ABANDONED', 'Completed', '', 'abandoned ']) {
    expect(
      await sqlState(insert({ key: freshKey(), status, request_hash: HASH, response: null })),
      JSON.stringify(status),
    ).toBe(CHECK_VIOLATION);
  }
  expect(
    await sqlState(
      insert({ key: freshKey(), status: 'canceled', request_hash: null, response: null }),
    ),
  ).toBe(CHECK_VIOLATION);
});

it('[AC-CT-16b#7] a business write on an abandoned key fails on the unique scope key and rolls back', async () => {
  const key = freshKey();
  expect(
    await sqlState(insert({ key, status: 'abandoned', request_hash: null, response: null })),
  ).toBe('no error');
  // The business result and the idempotency record are written in one transaction (04 §3.2);
  // the record insert fails on the unique key, so nothing of the transaction stays. The
  // business effect is stood in for by another row the same transaction writes first.
  const effectKey = freshKey();
  const state = await sqlState(
    app.transaction().execute(async (trx) => {
      await sql`
        INSERT INTO app.idempotency_keys
          (app_id, subject, user_id, method, path, key, request_hash, status, response, expire_at)
        VALUES ('couli', 'u:0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a61', NULL, 'POST',
                '/v1/me/payout-account', ${effectKey}, ${HASH}, 'completed', ${STORED}::jsonb,
                now() + interval '30 days')
      `.execute(trx);
      await sql`
        INSERT INTO app.idempotency_keys
          (app_id, subject, user_id, method, path, key, request_hash, status, response, expire_at)
        VALUES ('couli', 'u:0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a61', NULL, 'POST',
                '/v1/withdrawals', ${key}, ${HASH}, 'completed', ${STORED}::jsonb,
                now() + interval '30 days')
      `.execute(trx);
    }),
  );
  expect(state).toBe(UNIQUE_VIOLATION);
  const rows = await sql<{ status: string; request_hash: string | null }>`
    SELECT status, request_hash FROM app.idempotency_keys WHERE key = ${key}
  `.execute(app);
  expect(rows.rows).toEqual([{ status: 'abandoned', request_hash: null }]);
  const effect = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.idempotency_keys WHERE key = ${effectKey}
  `.execute(app);
  expect(effect.rows).toEqual([{ n: '0' }]);
});

it('[AC-CT-16b#8] a row cannot be turned into an abandoned row while it keeps its hash or response', async () => {
  const key = freshKey();
  expect(
    await sqlState(insert({ key, status: 'completed', request_hash: HASH, response: STORED })),
  ).toBe('no error');
  expect(
    await sqlState(
      sql`UPDATE app.idempotency_keys SET status = 'abandoned' WHERE key = ${key}`.execute(app),
    ),
  ).toBe(CHECK_VIOLATION);
  const abandoned = freshKey();
  expect(
    await sqlState(
      insert({ key: abandoned, status: 'abandoned', request_hash: null, response: null }),
    ),
  ).toBe('no error');
  expect(
    await sqlState(
      sql`UPDATE app.idempotency_keys SET status = 'completed' WHERE key = ${abandoned}`.execute(
        app,
      ),
    ),
  ).toBe(CHECK_VIOLATION);
});
