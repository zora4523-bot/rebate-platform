// B3-09c: real PG, business role only; no DDL/permission assertions in this task.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { createPgResultSetStore } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import type {
  ResultSetInput,
  SearchConditions,
} from '../../../../apps/api/src/modules/agent/orchestrator/results/types.ts';
export { delivered, product } from '../orchestrator-results/kit.ts';

export const APP = 'synthetic-results-app';
export const OTHER_APP = 'synthetic-results-other-app';
export const CONDITIONS: SearchConditions = {
  q: '合成牛奶',
  platforms: ['jd', 'taobao'],
  sort: 'sales_desc',
  price_min_fen: 100,
  price_max_fen: 5000,
  spec: '24盒',
  page: 2,
  chain_id: 'synthetic-chain-z',
};

export interface Scope {
  appId: string;
  sessionId: string;
  runId: string;
}

export function databaseKit() {
  let database: TestDatabase | undefined;
  let pool: Kysely<DB> | undefined;
  beforeAll(async () => {
    database = await createTestDatabase();
    pool = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  }, 180_000);
  afterAll(async () => {
    if (pool) await destroyDb(pool);
    if (database) await database.drop();
  });
  function db(): Kysely<DB> {
    expect(pool, 'PG fixture is ready').toBeDefined();
    return pool!;
  }
  async function run(appId: string, sessionId: string): Promise<Scope> {
    const runId = randomUUID();
    const clock = new FixedClock('2026-10-22T00:00:00Z');
    await sql`INSERT INTO app.agent_runs
      (id, app_id, session_id, accepted_at, quota_subjects, prompt_version, deadline_at)
      VALUES (${runId}, ${appId}, ${sessionId}, ${clock.now()},
        ${['["device","synthetic-device"]']}, 'synthetic@1', ${clock.now()})`.execute(db());
    return { appId, sessionId, runId };
  }
  async function scope(appId = APP): Promise<Scope> {
    const deviceId = randomUUID();
    const sessionId = randomUUID();
    const clock = new FixedClock('2026-10-22T00:00:00Z');
    await sql`INSERT INTO app.devices
      (id, app_id, install_secret_cipher, device_hash, id_source, platform, app_version, last_seen_at)
      VALUES (${deviceId}, ${appId}, ${Buffer.from('synthetic-install-secret')},
        ${deviceId.replaceAll('-', '').repeat(2)}, 'idfv', 'ios', 'synthetic@1', ${clock.now()})`.execute(
      db(),
    );
    await sql`INSERT INTO app.agent_sessions
      (id, app_id, device_id, started_at, last_active_at)
      VALUES (${sessionId}, ${appId}, ${deviceId}, ${clock.now()}, ${clock.now()})`.execute(db());
    return run(appId, sessionId);
  }
  function store() {
    return createPgResultSetStore({ db: db() });
  }
  return { db, scope, run, store };
}

export function input(scope: Scope, conditions = CONDITIONS): ResultSetInput {
  return { ...scope, id: randomUUID(), conditions };
}
