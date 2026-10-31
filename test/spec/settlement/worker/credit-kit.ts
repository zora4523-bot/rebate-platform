// B2-04ze round 2 kit: SettlementModule.forWorker over the real credit pieces (B2-04m credit order,
// B2-04q beneficiary credit, B2-04p executor), so that the ports app.module hands in are checked
// where they are used: readAttribution must reach both credit factories (HANDOFF 10-27: without it
// an order whose commission_version order-sync moved to 2 without v2 snapshot rows rolls back as a
// whole), and the minors reader must reach the BeneficiaryGate (BR-ID-26, BR-CALC-13).
// Orders, users, ledger and the commission snapshot come from the B2-04m harness
// (test/spec/settlement/credit/kit.ts); batches from the B2-04p kit. The other modules' ports are
// the real exports (commission, ledger, identity, risk) except the asset snapshot status (complete)
// and the configuration (a map: settle.auto.enabled unset, credit.enabled.<platform> as given).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { getOrderNets } from '../../../../apps/api/src/modules/ledger/index.ts';
import type { EventBus, JobHandler } from '../../../../apps/api/src/modules/platform/index.ts';
import { createRiskStateBatchReader } from '../../../../apps/api/src/modules/risk/index.ts';
import type { SettlementWorkerPorts } from '../../../../apps/api/src/modules/settlement/worker/index.ts';
import type { Harness, SeededOrder } from '../credit/kit.ts';
import {
  FAKE_CRYPTO,
  TAOBAO,
  fakeQueue,
  settleHandler,
  settlementModule,
  silentRootLogger,
  workerContext,
} from './kit.ts';

// identity's and commission's barrels at run time (their Nest classes stay out of the spec
// project's compile), like the B2-04m kit.
const identity = (await import(
  new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/identity/ports/realname-status-batch.ts') &
  typeof import('../../../../apps/api/src/modules/identity/ports/user-deletion-status.ts');

const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  readonly readCommissionAttribution: SettlementWorkerPorts['readAttribution'];
  readonly readCommissionSnapshot: SettlementWorkerPorts['readSnapshot'];
};

/** order-sync's write time (between the orders' attr_at and the harness clock). */
const SYNC_AT = '2032-07-10T10:00:00+08:00';

/**
 * The worker ports over the harness: readAttribution / readSnapshot are spies around commission's
 * real readers, minors answers the harness's minors (the users seeded with state 'minor').
 */
export function workerPorts(h: Harness, switches: ReadonlyMap<string, unknown>) {
  const readAttribution = vi.fn<SettlementWorkerPorts['readAttribution']>((trx, input) =>
    commission.readCommissionAttribution(trx, input),
  );
  const readSnapshot = vi.fn<SettlementWorkerPorts['readSnapshot']>((trx, input) =>
    commission.readCommissionSnapshot(trx, input),
  );
  const appendBeneficiaryEvent = vi.fn<SettlementWorkerPorts['appendBeneficiaryEvent']>(
    (trx, input) => h.appendBeneficiaryEvent(trx, input),
  );
  const minors = vi.fn<SettlementWorkerPorts['minors']>(() => ({ read: h.minorRead }));
  const ports: SettlementWorkerPorts = {
    platforms: [TAOBAO],
    readAttribution,
    readSnapshot,
    readTljDeductFen: h.readTljDeductFen,
    appendBeneficiaryEvent,
    readUnionAuthoritative: async () => new Set<string>(),
    snapshotStatus: async () => ({
      state: 'complete' as const,
      snapshotId: null,
      waitingComparable: null,
    }),
    registerDiff: () => Promise.reject(new Error('synthetic registerDiff was not expected')),
    readOrderNets: getOrderNets,
    ledger: () => ({
      openUserAccount: h.openUserAccount,
      lockBalances: h.lockBalances,
      post: h.post,
    }),
    lockUsers: h.identityLock,
    deletionStatus: (db) => identity.createUserDeletionStatusReader({ db }),
    realnameStatus: (db) => identity.createRealnameStatusBatchReader({ db }),
    riskState: (db) => createRiskStateBatchReader({ db }),
    minors,
    config: () => ({ get: async (_appId: string, key: string) => switches.get(key) }),
  };
  return { ports, readAttribution, readSnapshot, appendBeneficiaryEvent, minors };
}

/**
 * SettlementModule.forWorker(ports) in a Nest context on `db` at the harness clock, with the
 * harness's transactional event writer as EVENT_BUS; runs `body` with the settle handler.
 */
export async function withWorker(
  ports: SettlementWorkerPorts,
  h: Harness,
  db: Kysely<DB>,
  body: (handler: JobHandler) => Promise<void>,
): Promise<void> {
  const SettlementModule = await settlementModule();
  const queue = fakeQueue();
  const events: EventBus = { publish: h.publish };
  const context = await workerContext(SettlementModule.forWorker(ports), {
    clock: h.clock,
    logger: silentRootLogger(),
    db,
    queue,
    crypto: FAKE_CRYPTO,
    events,
  });
  try {
    await body(settleHandler(queue));
  } finally {
    await context.close();
  }
}

/** The asserting snapshot reader refuses the order at `version` (no snapshot rows of it). */
export async function snapshotRefused(h: Harness, o: SeededOrder, version: number): Promise<void> {
  const attempt = h.db.transaction().execute((trx) =>
    commission.readCommissionSnapshot(trx, {
      appId: h.appId,
      orderId: o.orderId,
      commissionVersion: version,
    }),
  );
  await expect(attempt).rejects.toThrow(/commission_version/u);
}

/**
 * order-sync's write (BR-FUND-03 / BR-CALC-10): commission_version moved to `version` in one CAS on
 * row_version; no snapshot amount rows of that version are written.
 */
export async function bumpCommissionVersion(
  h: Harness,
  o: SeededOrder,
  version: number,
): Promise<void> {
  const row = await h.read(o);
  const result = await h.db
    .updateTable('orders')
    .set({
      commission_version: version,
      row_version: row.row_version + 1,
      updated_at: new Date(SYNC_AT),
    })
    .where('app_id', '=', h.appId)
    .where('order_id', '=', o.orderId)
    .where('row_version', '=', row.row_version)
    .executeTakeFirst();
  expect(result.numUpdatedRows).toBe(1n);
}

/** A beneficiary item of batch `batchId` for an existing obligation of `o`; returns the item id. */
export async function beneficiaryItemOf(
  h: Harness,
  batchId: string,
  o: SeededOrder,
  obligation: {
    readonly beneficiary_credit_id: string;
    readonly user_id: string;
    readonly role: string;
  },
): Promise<string> {
  const id = randomUUID();
  await h.db
    .insertInto('settle_batch_items')
    .values({
      id,
      app_id: h.appId,
      batch_id: batchId,
      item_type: 'beneficiary',
      order_id: o.orderId,
      user_id: obligation.user_id,
      role: obligation.role,
      beneficiary_credit_id: obligation.beneficiary_credit_id,
      settle_seq: o.seq,
      b_settle_fen: null,
      amount_fen: null,
      result: null,
      skip_reason: null,
      created_at: new Date('2032-07-24T08:00:00+08:00'),
    })
    .execute();
  return id;
}
