// B2-15c: the handler of queue `pay` on the worker entry (08 BR-PAY-04, BR-PAY-05 ④, BR-PAY-07;
// task §9.4 ～ §9.7; D-PAY-11, D10-168). Jobs by name:
//   order.query    one channel query of an order, judged by the same checks and the same
//                  settlement as a notification (application/pay-query.ts); a scheduled query of a
//                  still PENDING order enqueues the next slot of `pay.query_schedule` (or, at
//                  expire_at, hands the order to order.close). A paid answer for an order already
//                  CLOSED (closed after the job was enqueued) is an anomaly receipt (BR-PAY-05 ④),
//                  never a PO2. A failure inside the settlement rolls all of it back; the attempt
//                  row stays.
//   biz.reconcile  the business object's fulfilment, recomputed from the current payment and refund
//                  facts under the object lock (pay_fulfillments), never added or subtracted
//                  (application/pay-fulfillment.ts).
//   order.close    B2-15d: the close flow of one order (application/pay-close.ts): query first,
//                  close on the channel, PO3 only on an explicit «closed» (or «not exist» past the
//                  grace), its own next run while still PENDING, needs_manual after the wait.
//   refund.query   B2-15e: one channel query of a PROCESSING refund, judged by the same checks and
//                  the same result handler as a refund notification (application/pay-refund-
//                  query.ts, pay-refund-result.ts); without a verdict the next slot is enqueued,
//                  the refund is never submitted again under the same number.
//   bill.recon     B2-15j: the T+1 reconciliation of one app (application/pay-recon.ts): the bill
//                  of the +08:00 accounting day before now of every enabled channel, checked line
//                  by line (R4 recon diffs, anomaly receipts, PAY_FEE), then the next day's run.
// Also compiled by the `test` project: erasable syntax only.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { Clock, EventBus, JobHandler, JobQueue, RootLogger } from '../../platform/index.ts';
import type { BizTypeRegistry } from '../application/biz-registry.ts';
import type { PayChannelSet } from '../application/pay-channel.ts';
import { runOrderClose } from '../application/pay-close.ts';
import { runBizReconcile } from '../application/pay-fulfillment.ts';
import { runOrderQuery } from '../application/pay-query.ts';
import { runBillReconJob } from '../application/pay-recon.ts';
import { runRefundQuery } from '../application/pay-refund-query.ts';
import type { PayLedgerPort } from '../application/pay-settlement.ts';
import {
  BILL_RECON_JOB,
  BIZ_RECONCILE_JOB,
  ORDER_CLOSE_JOB,
  ORDER_QUERY_JOB,
  REFUND_QUERY_JOB,
} from './names.ts';

export type { PayLedgerPort } from '../application/pay-settlement.ts';

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
  return async (job) => {
    switch (job.name) {
      case ORDER_QUERY_JOB:
        await runOrderQuery(deps, job.payload);
        return;
      case BIZ_RECONCILE_JOB:
        await runBizReconcile(deps, job.payload);
        return;
      case REFUND_QUERY_JOB:
        await runRefundQuery(deps, job.payload);
        return;
      case ORDER_CLOSE_JOB:
        await runOrderClose(deps, job.payload);
        return;
      case BILL_RECON_JOB:
        await runBillReconJob(deps, job.payload);
        return;
      default:
        deps.logger.error({ job_id: job.id, job_name: job.name }, 'pay_job_unknown');
        throw new Error('payment: unknown job name on queue pay');
    }
  };
}
