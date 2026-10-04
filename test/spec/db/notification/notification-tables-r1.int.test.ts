// Addition after the rule-test review round 1 of B1-12a (out_of_scope entry of the review):
// push_tokens.device_id references the device row (规划/04 §3.2 push_tokens: user_id 与 bound_sid
// 都在锁住设备行的同一事务内写入; written like links.device_id in 0006, a composite key with
// app_id allowed; db/AGENTS.md #7 外键禁止级联). Real PostgreSQL as couli_app. Top-level it() only
// (规划/11 §4.3).
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  FOREIGN_KEY_VIOLATION,
  foreignKeys,
  insertRow,
  newDevice,
  sqlState,
  unique,
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

it('[AC-B1-12a#26] push_tokens.device_id references devices.id without cascade; an unknown device is rejected (04 §3.2 push_tokens; db/AGENTS.md #7)', async () => {
  const fks = (await foreignKeys('push_tokens')).filter((fk) => fk.columns.includes('device_id'));
  expect(fks.length, 'a foreign key on device_id').toBeGreaterThan(0);
  for (const fk of fks) {
    expect(fk.target, fk.name).toBe('devices');
    // Each local column maps to its counterpart: device_id → id, app_id → app_id when composite.
    const pairs = fk.columns.map((c, i) => `${c}->${String(fk.targetColumns[i])}`).sort();
    expect([['device_id->id'], ['app_id->app_id', 'device_id->id']], fk.name).toContainEqual(pairs);
    expect(['a', 'r'], `${fk.name} ON DELETE`).toContain(fk.onDelete);
    expect(['a', 'r'], `${fk.name} ON UPDATE`).toContain(fk.onUpdate);
  }
  const row = {
    app_id: 'couli',
    provider: 'apns',
    token: unique('tok-'),
    token_set_at: new Date('2026-10-04T08:00:00Z'),
  };
  expect(await sqlState(insertRow('push_tokens', { ...row, device_id: randomUUID() }))).toBe(
    FOREIGN_KEY_VIOLATION,
  );
  expect(await sqlState(insertRow('push_tokens', { ...row, device_id: await newDevice() }))).toBe(
    'no error',
  );
});
