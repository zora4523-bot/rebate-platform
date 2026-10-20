// F1-02zk §9.2–9.3 (BR-FUND-19/20). No business implementation is used as the oracle.
// Database provisioning is supplied by *.int.test.ts, never imported by this fixture.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';
import {
  createSystemSwitchWriter,
  type SystemSwitchInput,
} from '../../../../apps/api/src/modules/content/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';

export const KEY = 'settle.auto.enabled';
export const NOW = '2026-10-20T03:04:05.000Z';
export const SEEDED_AT = '2026-10-01T00:00:00.000Z';
export const appId = () => `f102zk_${randomUUID().replaceAll('-', '').slice(0, 24)}`;

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
  const writer = createSystemSwitchWriter({ clock, logger });
  const input: SystemSwitchInput = {
    appId: id,
    key: KEY,
    source: 'daily_check',
    reason: 'global_difference',
  };
  return { clock, lines, writer, input };
}

export function alerts(lines: readonly string[]) {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.msg === 'config_change_alert');
}

export async function seedRow(
  db: Kysely<DB>,
  id: string,
  value: DB['config_items']['value'],
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

export async function seedHistory(db: Kysely<DB>, id: string, version: number) {
  await db
    .withSchema('app')
    .insertInto('config_item_versions')
    .values({
      app_id: id,
      key: KEY,
      version,
      value: sql`'true'::jsonb`,
      updated_by: 'seed',
      updated_by_admin_id: null,
      reason: 'earlier_change',
      created_at: SEEDED_AT,
    })
    .execute();
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
