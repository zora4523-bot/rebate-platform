import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { RegisterReconDiffInput } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';

export const TIMEOUT = 120_000;
export const INSTANT = '2032-06-15T15:59:59.999Z';
export function fixture(overrides: Partial<RegisterReconDiffInput> = {}) {
  return {
    clock: new FixedClock(INSTANT),
    input: {
      appId: `recon-${randomUUID()}`,
      type: 'ledger_mismatch',
      source: 'R3',
      period: '2032-06-15',
      refType: 'account',
      refId: randomUUID(),
      expectedFen: 4900n,
      actualFen: 5000n,
      diffFen: -100n,
      dedupeKey: null,
      resolution: null,
      ...overrides,
    } satisfies RegisterReconDiffInput,
  };
}
interface Database {
  urlFor(role: 'couli_app' | 'couli_readonly'): string;
  drop(): Promise<void>;
}
export async function open(create: () => Promise<Database>) {
  const database = await create();
  const app = database.urlFor('couli_app');
  return {
    database,
    db: createDb({ connectionString: app, max: 2 }),
    left: createDb({ connectionString: app, max: 1 }),
    right: createDb({ connectionString: app, max: 1 }),
    reader: createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 }),
  };
}
export type Harness = Awaited<ReturnType<typeof open>>;
export async function close(h: Harness | undefined) {
  if (!h) return;
  await Promise.all([h.db, h.left, h.right, h.reader].map(destroyDb));
  await h.database.drop();
}
export async function rows(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}
