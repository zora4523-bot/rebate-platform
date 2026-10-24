// B2-15c: the fulfilment of one business object, the handler of job `biz.reconcile` (08
// BR-PAY-04 「入队业务类型的开通任务（提交后执行）」, BR-PAY-01 细则「业务类型的接入要求」; D10-168;
// task §9.7). Under the business object lock the current payment facts are read — the object's
// PAID order and its refunded_fen (Σ SUCCESS refunds, kept by payment on the order) — the
// registered type's handler recomputes what the object is entitled to from those facts, and the
// result is set in pay_fulfillments (one row per object, version + 1, applied_at = now): active
// while the paid amount is not refunded in full, revoked once it is, none without a PAID order.
// Every run recomputes and sets; nothing is added on a grant or subtracted on a revoke, so a
// repeated job changes nothing but the version. A handler failure fails the job (the queue
// retries, then dead-letters with an alert) and never touches the payment result: the order
// stays PAID, its receipt voucher stays (BR-PAY-04 细则 「开通任务失败不回滚支付结果」).
// Also compiled by the `test` project (through jobs/pay-jobs.ts): erasable syntax only.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { newUuidV7, type Clock, type RootLogger } from '../../platform/index.ts';
import type { PayFulfillmentState } from '../domain/types.ts';
import {
  findPaidOrder,
  lockBizObject,
  upsertFulfillment,
  type BizObjectKey,
} from '../infra/pay-order-store.ts';
import type { BizReconcilePayload } from '../jobs/names.ts';
import type { BizTypeRegistry } from './biz-registry.ts';

export interface PayFulfillmentDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly registry: BizTypeRegistry;
  readonly logger: RootLogger;
}

function isPayload(value: unknown): value is BizReconcilePayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p['app_id'] === 'string' &&
    typeof p['biz_type'] === 'string' &&
    typeof p['biz_ref'] === 'string'
  );
}

/** The entitlement the facts imply (BR-PAY-01 细则: recomputed from paid and refunded). */
export function fulfillmentStateOf(
  paid: { readonly amountFen: bigint; readonly refundedFen: bigint } | null,
): PayFulfillmentState {
  if (paid === null) return 'none';
  return paid.refundedFen < paid.amountFen ? 'active' : 'revoked';
}

/** The handler of `biz.reconcile`. */
export async function runBizReconcile(deps: PayFulfillmentDeps, payload: unknown): Promise<void> {
  if (!isPayload(payload)) throw new Error('payment: biz.reconcile payload is malformed');
  const key: BizObjectKey = {
    appId: payload.app_id,
    bizType: payload.biz_type,
    bizRef: payload.biz_ref,
  };
  const entry = deps.registry.get(key.bizType);
  if (entry === undefined) {
    deps.logger.error({ app_id: key.appId, biz_type: key.bizType }, 'pay_fulfillment_unregistered');
    throw new Error('payment: the business type is not registered in this process');
  }
  try {
    const row = await deps.db.transaction().execute(async (trx) => {
      await lockBizObject(trx, key);
      const paid = await findPaidOrder(trx, key);
      const refundedFen = paid?.refunded_fen ?? 0n;
      await entry.fulfillment.reconcile(trx, {
        appId: key.appId,
        bizType: key.bizType,
        bizRef: key.bizRef,
        paid: paid !== undefined,
        refundedFen,
      });
      const now = deps.clock.now();
      return upsertFulfillment(trx, {
        id: newUuidV7(now),
        key,
        state: fulfillmentStateOf(
          paid === undefined ? null : { amountFen: paid.amount_fen, refundedFen },
        ),
        lastPayOrderId: paid?.id ?? null,
        refundedFen,
        appliedAt: now,
      });
    });
    deps.logger.info(
      {
        app_id: key.appId,
        biz_type: key.bizType,
        biz_ref: key.bizRef,
        state: row.state,
        version: row.version.toString(),
      },
      'pay_fulfillment_applied',
    );
  } catch (error: unknown) {
    // The payment result is untouched; the queue retries and dead-letters (持续失败告警).
    deps.logger.error(
      {
        app_id: key.appId,
        biz_type: key.bizType,
        biz_ref: key.bizRef,
        error_class: error instanceof Error ? error.name : typeof error,
      },
      'pay_fulfillment_failed',
    );
    throw error;
  }
}
