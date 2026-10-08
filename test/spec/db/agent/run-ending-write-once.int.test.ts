// B3-09a review R1: BR-AI-23 crash recovery must preserve ending facts even
// before final_event exists. Supplements #46/#47 without changing frozen tests.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { connect, insertRow, requireTable, sqlState } from '../linking-bindings/kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app') });
  connect(app);
});

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

type Row = Record<string, unknown>;
const AT = new Date('2026-10-06T08:00:00Z');
const LATER = new Date('2026-10-06T08:01:00Z');
const OK = 'no error';
const REWRITE = '23001';

async function pendingRun(): Promise<string> {
  // Fail with an assertion before any DML if the migration is not implemented.
  await requireTable('agent_sessions');
  await requireTable('agent_runs');
  const deviceId = randomUUID();
  await insertRow('devices', {
    id: deviceId,
    app_id: 'couli',
    user_id: null,
    install_secret_cipher: Buffer.from('synthetic-install-secret'),
    last_seen_at: AT,
  });
  const sessionId = randomUUID();
  await sql`INSERT INTO app.agent_sessions
    (id, app_id, user_id, device_id, started_at, last_active_at)
    VALUES (${sessionId}, 'couli', NULL, ${deviceId}, ${AT}, ${AT})`.execute(app);
  const runId = randomUUID();
  await sql`INSERT INTO app.agent_runs
    (id, app_id, session_id, accepted_at, quota_subjects, prompt_version,
     final_event, ended_at, end_reason, settle_result, settled_at, card_delivered)
    VALUES (${runId}, 'couli', ${sessionId}, ${AT},
      ${['synthetic-device-key', 'synthetic-ip-key']}, 'synthetic@1',
      NULL, NULL, NULL, NULL, NULL, false)`.execute(app);
  return runId;
}

async function updateRun(id: string, values: Row): Promise<void> {
  const result = await sql`UPDATE app.agent_runs SET
    ${sql.join(Object.entries(values).map(([key, value]) => sql`${sql.ref(key)} = ${value}`))}
    WHERE app_id = 'couli' AND id = ${id} RETURNING id`.execute(app);
  expect(result.rows).toEqual([{ id }]);
}

async function readRun(id: string): Promise<Row> {
  const result = await sql<Row>`SELECT * FROM app.agent_runs
    WHERE app_id = 'couli' AND id = ${id}`.execute(app);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

for (const [label, replacement] of [
  ['replace', 'cancelled'],
  ['clear', null],
] as const) {
  it(`[AC-B3-09a#57] cannot ${label} a recorded end_reason before settlement or final_event`, async () => {
    const id = await pendingRun();
    expect(await sqlState(updateRun(id, { end_reason: 'stop' }))).toBe(OK);
    const before = await readRun(id);
    expect(before).toMatchObject({
      end_reason: 'stop',
      settle_result: null,
      settled_at: null,
      final_event: null,
      ended_at: null,
    });

    expect(await sqlState(updateRun(id, { end_reason: replacement }))).toBe(REWRITE);
    expect(await readRun(id)).toEqual(before);
  });
}

const SETTLEMENT_REWRITES: { label: string; values: Row }[] = [
  { label: 'replace counted with refunded', values: { settle_result: 'refunded' } },
  {
    label: 'replace both settlement facts',
    values: { settle_result: 'refunded', settled_at: LATER },
  },
  { label: 'clear both settlement facts', values: { settle_result: null, settled_at: null } },
  { label: 'clear only settle_result', values: { settle_result: null } },
  { label: 'clear only settled_at', values: { settled_at: null } },
  { label: 'replace only settled_at', values: { settled_at: LATER } },
];

for (const { label, values } of SETTLEMENT_REWRITES) {
  it(`[AC-B3-09a#58] cannot ${label} while final_event is still NULL`, async () => {
    const id = await pendingRun();
    expect(await sqlState(updateRun(id, { end_reason: 'stop' }))).toBe(OK);
    expect(await sqlState(updateRun(id, { settle_result: 'counted', settled_at: AT }))).toBe(OK);
    const before = await readRun(id);
    expect(before).toMatchObject({
      end_reason: 'stop',
      settle_result: 'counted',
      settled_at: AT,
      final_event: null,
      ended_at: null,
    });

    expect(await sqlState(updateRun(id, values))).toBe(REWRITE);
    expect(await readRun(id)).toEqual(before);
  });
}

for (const delivered of [false, true]) {
  it(`[AC-B3-09a#59] settled card_delivered=${String(delivered)} cannot change before final_event`, async () => {
    const id = await pendingRun();
    expect(await sqlState(updateRun(id, { end_reason: 'stop', card_delivered: delivered }))).toBe(
      OK,
    );
    expect(await sqlState(updateRun(id, { settle_result: 'counted', settled_at: AT }))).toBe(OK);
    const before = await readRun(id);
    expect(before).toMatchObject({
      card_delivered: delivered,
      end_reason: 'stop',
      settle_result: 'counted',
      settled_at: AT,
      final_event: null,
      ended_at: null,
    });

    expect(await sqlState(updateRun(id, { card_delivered: !delivered }))).toBe(REWRITE);
    expect(await readRun(id)).toEqual(before);
  });
}
