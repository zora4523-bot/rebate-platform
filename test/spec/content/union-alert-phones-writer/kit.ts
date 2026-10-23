// F1-02zzj §9.2–9.3 (D10-281, D10-152 ④): helpers of the union.auth_alert_phones write port
// rules. No business implementation is used as the oracle. Database provisioning is supplied by
// the *.int.test.ts files, never imported by this fixture.
//
// Readings fixed by this kit:
// - the port is content's `createUnionAlertPhonesWriter({ clock, logger }).write(trx, input)`;
//   input fields are exactly appId, value, expectedVersion, adminId and the optional reason;
// - updated_by (both tables) names the operator: it contains the adminId; the history row's
//   updated_by_admin_id is the adminId;
// - a new row starts at version 1 / row_version 0, an update adds 1 to both; created_at and
//   updated_at come from the injected clock (an update keeps created_at);
// - MARK only ever appears inside stored values: no log line may contain it.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';
import {
  createUnionAlertPhonesWriter,
  type UnionAlertPhonesInput,
} from '../../../../apps/api/src/modules/content/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';

export const KEY = 'union.auth_alert_phones';
export const NOW = '2026-10-24T03:04:05.000Z';
export const SEEDED_AT = '2026-10-01T00:00:00.000Z';
export const MARK = 'f102zzjOpaqueCipherMark';
export const appId = () => `f102zzj_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
/** An opaque value as union would store it (B1-22b: `{ cipher: <FieldCrypto ciphertext> }`). */
export const cipherValue = (n: number | string) => ({ cipher: `v1.${MARK}.${n}` });

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export function databaseHarness(provision: () => Promise<TestDatabase>) {
  const h = {} as { db: Kysely<DB> };
  let database: TestDatabase | undefined;
  beforeAll(async () => {
    database = await provision();
    h.db = createDb({ connectionString: database.urlFor('couli_app') }).withSchema('app');
  }, 180_000);
  afterAll(async () => {
    try {
      if (h.db !== undefined) await destroyDb(h.db);
    } finally {
      await database?.drop();
    }
  });
  return h;
}

export function fixture(id = appId()) {
  const clock = new FixedClock(NOW);
  const { logger, lines } = memoryLogger();
  // Construct outside rejection assertions: the skeleton must fail negative cases as well.
  const writer = createUnionAlertPhonesWriter({ clock, logger });
  const adminId = randomUUID();
  const input: UnionAlertPhonesInput = {
    appId: id,
    value: cipherValue(1),
    expectedVersion: 0,
    adminId,
    reason: 'add_phone',
  };
  return { clock, lines, writer, input, adminId };
}

/** Log lines that carry any part of a stored value. */
export const leaked = (lines: readonly string[]) => lines.filter((line) => line.includes(MARK));

export async function seedRow(
  db: Kysely<DB>,
  id: string,
  value: unknown,
  version = 3,
  key = KEY,
) {
  await db
    .withSchema('app')
    .insertInto('config_items')
    .values({
      app_id: id,
      key,
      value: sql`${JSON.stringify(value)}::jsonb`,
      version,
      row_version: 7,
      updated_by: 'seed',
      created_at: SEEDED_AT,
      updated_at: SEEDED_AT,
    })
    .execute();
}

export async function seedHistory(
  db: Kysely<DB>,
  id: string,
  version: number,
  value: unknown,
  key = KEY,
) {
  await db
    .withSchema('app')
    .insertInto('config_item_versions')
    .values({
      app_id: id,
      key,
      version,
      value: sql`${JSON.stringify(value)}::jsonb`,
      updated_by: 'seed',
      updated_by_admin_id: null,
      reason: `earlier_${version}`,
      created_at: SEEDED_AT,
    })
    .execute();
}

/** A current row at `version` with history 1..version (values cipherValue(`s<n>`)). */
export async function seedWritten(db: Kysely<DB>, id: string, version: number, key = KEY) {
  for (let n = 1; n <= version; n += 1) await seedHistory(db, id, n, cipherValue(`s${n}`), key);
  await seedRow(db, id, cipherValue(`s${version}`), version, key);
}

export async function snapshot(db: Kysely<DB>, id: string) {
  const app = db.withSchema('app');
  return {
    items: await app
      .selectFrom('config_items')
      .selectAll()
      .where('app_id', '=', id)
      .orderBy('key')
      .execute(),
    versions: await app
      .selectFrom('config_item_versions')
      .selectAll()
      .where('app_id', '=', id)
      .orderBy('key')
      .orderBy('version')
      .execute(),
    audits: await app
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', id)
      .orderBy('id')
      .execute(),
  };
}

/**
 * Wait (at most 3 s) until `pending` settles or some session of this test database waits on a
 * lock. Only a scheduling aid for the race tests; the outcome is asserted by the caller.
 */
export async function blockedOrSettled(db: Kysely<DB>, pending: Promise<unknown>) {
  let settled = false;
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let waited = 0; waited < 3_000 && !settled; waited += 25) {
    const row = await sql<{ n: number }>`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`
      .execute(db)
      .then((result) => result.rows[0]);
    if ((row?.n ?? 0) > 0) return;
    await sleep(25);
  }
}
