// Delivery order is the order cards were handed out, never price order (B3-09c brief §10).
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { DeliveredProduct } from '../../orchestrator/results/types.ts';
import { createPgResultSetStore } from './index.ts';

const APP = 'synthetic-results-unit-app';
let database: TestDatabase | undefined;
let pool: Kysely<DB> | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);

afterAll(async () => {
  if (pool) await destroyDb(pool);
  if (database) await database.drop();
});

async function seedRun(db: Kysely<DB>): Promise<{ sessionId: string; runId: string }> {
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();
  const at = new Date('2026-10-22T00:00:00Z');
  await sql`INSERT INTO app.devices
    (id, app_id, install_secret_cipher, device_hash, id_source, platform, app_version, last_seen_at)
    VALUES (${deviceId}, ${APP}, ${Buffer.from('synthetic-install-secret')},
      ${deviceId.replaceAll('-', '').repeat(2)}, 'idfv', 'ios', 'synthetic@1', ${at})`.execute(db);
  await sql`INSERT INTO app.agent_sessions (id, app_id, device_id, started_at, last_active_at)
    VALUES (${sessionId}, ${APP}, ${deviceId}, ${at}, ${at})`.execute(db);
  await sql`INSERT INTO app.agent_runs
    (id, app_id, session_id, accepted_at, quota_subjects, prompt_version, deadline_at)
    VALUES (${runId}, ${APP}, ${sessionId}, ${at}, ${['["device","synthetic-device"]']},
      'synthetic@1', ${at})`.execute(db);
  return { sessionId, runId };
}

function item(cardId: string, price: number): DeliveredProduct {
  return {
    card_id: cardId,
    product_key: `jd:synthetic-${cardId}`,
    platform: 'jd',
    final_price_fen: price,
    card: {
      type: 'notice',
      schema_version: 1,
      data: { text_key: `synthetic.${cardId}` },
      fallback_text: '合成卡片',
    },
  };
}

it('[AC-B3-09c#2][BR-AI-05] 已投递卡按投递序返回，价格不单调也不重排', async () => {
  const db = pool!;
  const store = createPgResultSetStore({ db });
  const { sessionId, runId } = await seedRun(db);
  const id = randomUUID();
  await store.save({ id, appId: APP, sessionId, runId, conditions: { q: '合成', chain_id: 'z' } });
  const first = [item('c5', 3000), item('c1', 100), item('c3', 9000)];
  const later = [item('c2', 50), item('c4', 5000)];
  await store.recordDelivered(id, first);
  await store.recordDelivered(id, later);
  const latest = await store.latestWithProducts(APP, sessionId);
  expect(latest?.delivered).toEqual([...first, ...later]);
  expect(latest?.delivered.every((value) => typeof value.final_price_fen === 'number')).toBe(true);
  expect(await store.findDelivered(APP, sessionId, 'c3')).toEqual(first[2]);
});
