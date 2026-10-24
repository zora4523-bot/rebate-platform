// B2-15c: the handler of queue `pay` on the worker entry (08 BR-PAY-04, BR-PAY-05 ④, BR-PAY-07;
// task §9.4 ～ §9.7; D-PAY-11, D10-168). Skeleton of the rule-test phase: the factory throws
// NotImplemented. Jobs by name:
//   order.query    one channel query of an order, judged by the same checks and the same
//                  settlement as a notification; a scheduled query of a still PENDING order
//                  enqueues the next slot of `pay.query_schedule` (or, at expire_at, hands the
//                  order to order.close). A paid answer for an order already CLOSED (closed after
//                  the job was enqueued) is an anomaly receipt (BR-PAY-05 ④), never a PO2. A
//                  failure inside the settlement rolls all of it back; the attempt row stays.
//   biz.reconcile  the business object's fulfilment, recomputed from the current payment and refund
//                  facts under the object lock (pay_fulfillments), never added or subtracted.
//   order.close    B2-15d.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { PostingResult, PostingVoucher, RegisterReconDiffInput } from '../../ledger/index.ts';
import type { Clock, EventBus, JobHandler, JobQueue, RootLogger } from '../../platform/index.ts';
import type { BizTypeRegistry } from '../application/biz-registry.ts';
import type { PayChannelSet } from '../application/pay-channel.ts';

/** ledger's posting and recon diff registration, on the caller's transaction (BR-PAY-07). */
export interface PayLedgerPort {
  post(trx: Transaction<DB>, voucher: PostingVoucher): Promise<PostingResult>;
  registerReconDiff(
    trx: Transaction<DB>,
    input: RegisterReconDiffInput,
  ): Promise<{ readonly id: string }>;
}

export interface PayJobDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** content's configuration reader (pay.query_schedule, pay.<pay_channel>.success_states). */
  readonly config: Pick<ContentReader, 'configValue'>;
  readonly queue: JobQueue;
  readonly events: EventBus;
  readonly channels: Pick<PayChannelSet, 'of'>;
  readonly registry: BizTypeRegistry;
  readonly ledger: PayLedgerPort;
  readonly logger: RootLogger;
}

export function createPayJobHandler(deps: PayJobDeps): JobHandler {
  void deps;
  throw new Error('NotImplemented: createPayJobHandler');
}
