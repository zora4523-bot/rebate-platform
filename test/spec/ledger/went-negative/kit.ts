import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { vi } from 'vitest';
import {
  createLedger,
  type PostingVoucher,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
import { setupOn, teardown } from '../../platform/queue/int-kit.ts';
import { spec } from '../../platform/queue/kit.ts';
import { voucher } from '../posting/kit.ts';

export { TIMEOUT, account, entry, post, snapshot, bounded, waitBlocked } from '../posting/kit.ts';
export const INSTANT = '2032-06-15T15:59:59.999Z';
export const QUEUE = 'evt.negative-test';
const CATALOG = [spec(QUEUE, { deadLetter: null })];
interface Database {
  urlFor(role: 'couli_app' | 'couli_payout'): string;
  drop(): Promise<void>;
}
export async function open(create: () => Promise<Database>) {
  const database = await create();
  const connectionString = database.urlFor('couli_app');
  const setup = setupOn(database, 'api', {
    catalog: CATALOG,
    plan: { api: [], stream: [], admin: [], worker: [], payout: [] },
  });
  await setup.runtime.start();
  return {
    database,
    setup,
    db: createDb({ connectionString, max: 2 }),
    left: createDb({ connectionString, max: 1 }),
    right: createDb({ connectionString, max: 1 }),
  };
}
export type Harness = Awaited<ReturnType<typeof open>>;
export async function close(h: Harness | undefined) {
  if (!h) return;
  await teardown([h.setup]);
  await Promise.all([h.db, h.left, h.right].map(destroyDb));
  await h.database.drop();
}
export function context(h: Harness, appId = `negative-${randomUUID()}`) {
  const clock = new FixedClock(INSTANT);
  const send = vi.fn(h.setup.runtime.send.bind(h.setup.runtime));
  const bus = createEventBus({
    clock,
    queue: { send },
    catalog: CATALOG,
    subscriptions: [{ consumer: 'negative-test', events: ['account.went_negative'] }],
  });
  const publish = vi.fn(bus.publish.bind(bus));
  // Called inside each test: red is the factory's NotImplemented, never a beforeAll failure.
  const ledger = createLedger({ clock, eventBus: { publish } });
  return { clock, ledger, send, publish, appId };
}
/** Positive posting amount debits USER_BALANCE (reduces available); expected balances are literal. */
export function change(
  appId: string,
  accountId: string,
  debit: bigint,
  type = 'CLAWBACK',
  extra: Partial<PostingVoucher> = {},
) {
  const v = voucher(appId, accountId, debit, extra);
  return { ...v, entries: v.entries.map((e) => ({ ...e, ledger_type: type })) };
}
export async function events(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('event_log')
    .selectAll()
    .where('app_id', '=', appId)
    .where('name', '=', 'account.went_negative')
    .orderBy('event_id')
    .execute();
}
export async function jobs(db: Kysely<DB>, appId: string) {
  const result = await sql<{ id: string; data: unknown; state: string }>`
    SELECT id::text, data, state::text FROM pgboss.job
    WHERE name = ${QUEUE} AND data->'payload'->>'app_id' = ${appId}
    ORDER BY id`.execute(db);
  return result.rows;
}
