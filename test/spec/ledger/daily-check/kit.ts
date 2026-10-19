import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  createDailyCheck,
  type DailyCheckLogger,
  type LedgerInvariantSource,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';

export {
  account,
  balance,
  daily,
  entry,
  pair,
  platform,
  voucher,
} from '../../db/ledger/invariants/kit.ts';

export const DAY = '2032-06-15';
export const APP = 'daily-check-a';
export const OTHER = 'daily-check-b';
export const NOW = '2032-06-15T17:00:00.000Z';
export const TIMEOUT = 60_000;

export function setup(invariants?: LedgerInvariantSource) {
  const clock = new FixedClock(NOW);
  const logs: { level: string; fields: Record<string, unknown> }[] = [];
  const logger: DailyCheckLogger = {
    warn(fields) {
      logs.push({ level: 'warn', fields });
    },
    error(fields) {
      logs.push({ level: 'error', fields });
    },
  };
  // Called inside each it, before fixtures and outside rejects assertions: red is NotImplemented.
  const runner = createDailyCheck({ clock, logger, ...(invariants ? { invariants } : {}) });
  return { clock, logs, runner };
}

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export async function inDatabase(
  create: () => Promise<TestDatabase>,
  run: (db: Kysely<DB>) => Promise<void>,
) {
  const database = await create();
  // One pooled connection makes session-local setting leaks observable after the run.
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  try {
    await run(db);
  } finally {
    await destroyDb(db);
    await database.drop();
  }
}

export function invariantFiles() {
  const directory = new URL('../../../../db/invariants/ledger/', import.meta.url);
  const manifest = new URL('superseded.json', directory);
  const superseded = new Set<string>();
  if (existsSync(manifest)) {
    const entries: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    if (!Array.isArray(entries)) {
      throw new Error('superseded.json must be an array of objects');
    }
    for (const entry of entries as unknown[]) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        Array.isArray(entry) ||
        !('file' in entry) ||
        typeof entry.file !== 'string'
      ) {
        throw new Error('superseded.json entries must be objects with a string file field');
      }
      superseded.add(entry.file);
    }
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql') && !superseded.has(name))
    .sort()
    .map((name) => ({ name, sql: readFileSync(new URL(name, directory), 'utf8') }));
}

export async function snapshots(db: Kysely<DB>, appId = APP) {
  return db
    .selectFrom('daily_balances')
    .select([
      'app_id',
      'account_id',
      'sub_account',
      'opening_fen',
      'debit_fen',
      'credit_fen',
      'closing_fen',
      'computed_at',
    ])
    .select((eb) => eb.cast<string>('accounting_date', 'text').as('day'))
    .where('app_id', '=', appId)
    .orderBy('account_id')
    .orderBy('sub_account')
    .orderBy('accounting_date')
    .execute();
}

export async function immutableState(db: Kysely<DB>) {
  const accounts = await db.selectFrom('ledger_accounts').selectAll().orderBy('id').execute();
  const balances = await db
    .selectFrom('account_balances')
    .selectAll()
    .orderBy('account_id')
    .execute();
  const vouchers = await db.selectFrom('ledger_vouchers').selectAll().orderBy('id').execute();
  const entries = await db.selectFrom('ledger_entries').selectAll().orderBy('id').execute();
  return { accounts, balances, vouchers, entries };
}
