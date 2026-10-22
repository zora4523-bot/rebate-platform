import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely, KyselyPlugin } from 'kysely';
import { vi } from 'vitest';
import {
  createAssetSnapshot,
  type PendingEarningsSource,
  type PendingEarningsTotals,
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

export const APP = 'asset-snapshot-a';
export const OTHER = 'asset-snapshot-b';
export const DAY = '2032-06-15';
export const NOMINAL = '2032-06-15T16:01:00.000Z';
export const DEADLINE = '2032-06-15T16:30:00.000Z';
export const TIMEOUT = 60_000;

export function input(appId = APP, nominalRunAt = NOMINAL) {
  return { appId, nominalRunAt: new FixedClock(nominalRunAt).now() };
}

export function setup(now = NOMINAL, threshold: bigint | null = null) {
  const clock = new FixedClock(now);
  const readAppTotals = vi.fn<PendingEarningsSource['readAppTotals']>().mockResolvedValue({
    total_waiting_fen: 0n,
    total_estimated_fen: 0n,
  });
  const readUser = vi
    .fn<PendingEarningsSource['readUser']>()
    .mockRejectedValue(
      new Error('Snapshot must request app totals, including users without ledger accounts'),
    );
  const getAdvanceAlertFen = vi
    .fn<(appId: string) => Promise<bigint | null>>()
    .mockResolvedValue(threshold);
  const logger = { warn: vi.fn(), error: vi.fn() };
  const dependencies = {
    clock,
    pendingEarnings: { readAppTotals, readUser },
    getAdvanceAlertFen,
    logger,
  };
  // Factory is called inside each test, outside rejection assertions: skeleton red is explicit.
  const runner = createAssetSnapshot(dependencies);
  return { runner, dependencies, clock, readAppTotals, readUser, getAdvanceAlertFen, logger };
}

interface TestDatabase {
  urlFor(role: 'couli_app' | 'couli_readonly'): string;
  drop(): Promise<void>;
}

export async function inDatabase(
  create: () => Promise<TestDatabase>,
  run: (db: Kysely<DB>, reader: Kysely<DB>) => Promise<void>,
) {
  const database = await create();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 5 });
  const reader = createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 });
  try {
    await run(db, reader);
  } finally {
    await Promise.all([destroyDb(db), destroyDb(reader)]);
    await database.drop();
  }
}

export async function snapshots(db: Kysely<DB>, appId = APP) {
  return db
    .selectFrom('asset_snapshots')
    .selectAll()
    .select((eb) => eb.cast<string>('snapshot_date', 'text').as('day'))
    .where('app_id', '=', appId)
    .orderBy('snapshot_date')
    .execute();
}

export async function receivables(db: Kysely<DB>, appId = APP) {
  return db
    .selectFrom('asset_snapshot_receivables')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('asset_snapshot_id')
    .orderBy('platform')
    .execute();
}

export async function existingSnapshot(db: Kysely<DB>, appId = APP, day = DAY, comparable = true) {
  const id = randomUUID();
  const at = new FixedClock(NOMINAL).now();
  await db
    .insertInto('asset_snapshots')
    .values({
      id,
      app_id: appId,
      snapshot_date: day,
      waiting_comparable: comparable,
      total_available_positive_fen: 0n,
      total_negative_fen: 0n,
      total_frozen_fen: 0n,
      total_waiting_fen: 0n,
      total_estimated_fen: 0n,
      created_at: at,
      updated_at: at,
    })
    .execute();
  return id;
}

export function totals(waiting: bigint, estimated: bigint): PendingEarningsTotals {
  return { total_waiting_fen: waiting, total_estimated_fen: estimated };
}

/** A real write fails at the child-table statement; parent must roll back with it. */
export function failReceivableWrite(error: Error): KyselyPlugin {
  return {
    transformQuery({ node }) {
      if (
        node.kind === 'InsertQueryNode' &&
        node.into?.table.identifier.name === 'asset_snapshot_receivables'
      ) {
        throw error;
      }
      return node;
    },
    transformResult({ result }) {
      return Promise.resolve(result);
    },
  };
}

export function alerts(
  logger: ReturnType<typeof setup>['logger'],
  event: 'asset_snapshot_timeout' | 'ledger_advance_exposure',
): Record<string, unknown>[] {
  return [...logger.warn.mock.calls, ...logger.error.mock.calls]
    .map((call) => call[0] as Record<string, unknown>)
    .filter((fields) => fields['event'] === event);
}
