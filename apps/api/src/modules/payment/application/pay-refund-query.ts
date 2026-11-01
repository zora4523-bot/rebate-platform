// B2-15e: the active query of one PROCESSING refund (08 BR-PAY-06 ④ 「主动查询」, ⑤ 「结果未知时只查询」;
// D10-351 ③), the handler of job `refund.query`. The first query is enqueued, delayed, in the
// transaction that creates the refund (application/pay-refunds.ts), before the channel is asked
// for the refund; so a refund whose submission never answered (an unknown answer, a throwing
// adapter, a process that went away mid-call) is still queried, and never submitted again under
// the same out_refund_no (BR-PAY-09 验证之前不允许). A still PROCESSING refund with no verdict gets
// the next slot of domain/out-refund-no.ts REFUND_QUERY_SCHEDULE_SECONDS relative to its creation;
// after the last slot the worker alerts and leaves it to the console.
// Every query writes one pay_query_attempts row (kind refund_query, pay_refund_id) in its own
// transaction before any judgement, so the attempt stays when the result is rolled back. The
// answer is handed to the same result handler as a refund notification
// (application/pay-refund-result.ts): identity through ownerAppOf against the refund's app, the
// original's numbers, the channel, the amount and the state lists, under the target's lock on a
// fresh read. An answer without the channel state, the amount or the identity never counts
// (fail closed). Nothing of a channel-side user reaches a log line; amounts stay bigint fen.
// Also compiled by the `test` project (through jobs/pay-jobs.ts): erasable syntax only.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { newUuidV7 } from '../../platform/index.ts';
import { nextRefundQueryInstant, refundQuerySlotSeconds } from '../domain/out-refund-no.ts';
import { delaySecondsUntil } from '../domain/pay-result.ts';
import type { PayChannelCode } from '../domain/types.ts';
import { findOrderById } from '../infra/pay-order-store.ts';
import {
  findAnomalyById,
  findRefundById,
  insertRefundAttempt,
  type PayRefundRow,
} from '../infra/pay-refund-store.ts';
import {
  PAY_QUEUE,
  REFUND_QUERY_JOB,
  refundQueryKey,
  type RefundQueryPayload,
} from '../jobs/names.ts';
import type {
  PayChannel,
  PayChannelSet,
  PayRefundOriginal,
  PayRefundQueryResult,
} from './pay-channel.ts';
import {
  PayRefundConflict,
  handleRefundReport,
  type PayRefundOutcome,
} from './pay-refund-result.ts';
import type { PaySettlementDeps } from './pay-settlement.ts';

export interface PayRefundQueryDeps extends PaySettlementDeps {
  readonly db: Kysely<DB>;
  readonly channels: Pick<PayChannelSet, 'of'>;
}

function isPayload(value: unknown): value is RefundQueryPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return typeof p['app_id'] === 'string' && typeof p['pay_refund_id'] === 'string';
}

interface RefundTarget {
  readonly channel: PayChannelCode;
  /** B2-15k: Alipay's refund query names the original (docs-mirror/alipay/app-pay/01dcc0.md). */
  readonly original: PayRefundOriginal;
}

/** A refund's target as the channel knows it: pay_channel and numbers (the refund row has neither). */
async function targetOf(db: Kysely<DB>, refund: PayRefundRow): Promise<RefundTarget | undefined> {
  const target =
    refund.target_type === 'pay_order'
      ? await findOrderById(db, refund.app_id, refund.target_id)
      : await findAnomalyById(db, refund.app_id, refund.target_id);
  if (target === undefined) return undefined;
  return {
    channel: target.pay_channel as PayChannelCode,
    original: { outTradeNo: target.out_trade_no, channelTradeNo: target.channel_trade_no },
  };
}

async function queryChannel(
  adapter: PayChannel,
  outRefundNo: string,
  original: PayRefundOriginal,
): Promise<PayRefundQueryResult> {
  try {
    return await adapter.refundQuery(outRefundNo, original);
  } catch (error: unknown) {
    // A throwing adapter is an unknown answer (payment/AGENTS.md rule 7).
    return {
      kind: 'unknown',
      reason: error instanceof Error ? `adapter_error:${error.name}` : 'adapter_error',
    };
  }
}

/**
 * Enqueues the next query slot of a still PROCESSING refund (singletonKey
 * refund.query:<pay_refund_id>:t<seconds>: one queued or active per slot); past the last slot an
 * alert instead (the console shows the refund as PROCESSING; BR-PAY-09 decides what then).
 */
export async function scheduleNextRefundQuery(
  deps: Pick<PayRefundQueryDeps, 'queue' | 'logger'>,
  refund: PayRefundRow,
  now: Date,
): Promise<void> {
  const next = nextRefundQueryInstant(refund.created_at, now);
  const fields = {
    app_id: refund.app_id,
    pay_refund_id: refund.id,
    out_refund_no: refund.out_refund_no,
  };
  if (next === null) {
    deps.logger.warn(fields, 'pay_refund_query_exhausted');
    return;
  }
  const payload: RefundQueryPayload = { app_id: refund.app_id, pay_refund_id: refund.id };
  await deps.queue.send(PAY_QUEUE, REFUND_QUERY_JOB, payload, {
    trx: null,
    singletonKey: refundQueryKey(refund.id, refundQuerySlotSeconds(refund.created_at, next)),
    delaySeconds: delaySecondsUntil(now, next),
  });
}

/** The handler of `refund.query`. */
export async function runRefundQuery(deps: PayRefundQueryDeps, payload: unknown): Promise<void> {
  if (!isPayload(payload)) throw new Error('payment: refund.query payload is malformed');
  const refund = await findRefundById(deps.db, payload.app_id, payload.pay_refund_id);
  if (refund === undefined) {
    deps.logger.warn({ app_id: payload.app_id }, 'pay_refund_query_refund_missing');
    return;
  }
  const base = {
    app_id: refund.app_id,
    pay_refund_id: refund.id,
    out_refund_no: refund.out_refund_no,
  };
  if (refund.status !== 'PROCESSING') {
    // Decided already (a notification or an earlier query): nothing to ask, nothing to schedule.
    deps.logger.info({ ...base, status: refund.status }, 'pay_refund_query_skipped_final');
    return;
  }
  const target = await targetOf(deps.db, refund);
  if (target === undefined) throw new Error('payment: the refund target vanished');
  const { channel, original } = target;
  const adapter = deps.channels.of(channel);
  const result = await queryChannel(adapter, refund.out_refund_no, original);
  const now = deps.clock.now();
  // The attempt row commits on its own, before the judgement (it must survive a rolled-back
  // result; the channel was asked whatever happens next).
  await deps.db.transaction().execute((trx) =>
    insertRefundAttempt(trx, {
      id: newUuidV7(now),
      appId: refund.app_id,
      payRefundId: refund.id,
      kind: 'refund_query',
      request: { op: 'refund_query', pay_channel: channel, out_refund_no: refund.out_refund_no },
      response:
        result.kind === 'ok'
          ? {
              kind: 'ok',
              state: result.state,
              channel_state: result.channelState ?? null,
              refund_fen: result.refundFen === null ? null : result.refundFen.toString(),
              out_trade_no: result.outTradeNo ?? null,
              channel_trade_no: result.channelTradeNo ?? null,
              channel_refund_no: result.channelRefundNo ?? null,
              identity_reported: result.merchantRef !== undefined && result.appRef !== undefined,
            }
          : { kind: 'unknown', reason: result.reason },
      result: result.kind === 'ok' ? result.state : 'unknown',
      at: now,
    }),
  );
  if (result.kind === 'unknown') {
    deps.logger.warn(
      { ...base, pay_channel: channel, reason: result.reason },
      'pay_refund_query_unknown',
    );
    await scheduleNextRefundQuery(deps, refund, now);
    return;
  }
  if (result.state === 'not_exist') {
    // 「单据不存在」is no result either (BR-PAY-06 ⑤): the submission may not have reached the
    // channel, or not yet; the refund stays PROCESSING and is queried again, never resubmitted.
    deps.logger.warn({ ...base, pay_channel: channel }, 'pay_refund_query_not_exist');
    await scheduleNextRefundQuery(deps, refund, now);
    return;
  }
  // ① the identity: reported, and ours — resolved by this channel's configuration to the refund's
  // app; an answer without it, or of another app, is nobody's (fail closed).
  const ours =
    result.merchantRef !== undefined &&
    result.appRef !== undefined &&
    adapter.ownerAppOf({ merchantRef: result.merchantRef, appRef: result.appRef }) ===
      refund.app_id;
  let outcome: PayRefundOutcome;
  try {
    outcome = await deps.db.transaction().execute((trx) =>
      handleRefundReport(deps, trx, {
        source: 'query',
        channel,
        appId: refund.app_id,
        ours,
        outRefundNo: refund.out_refund_no,
        outTradeNo: result.outTradeNo ?? null,
        channelTradeNo: result.channelTradeNo ?? null,
        refundFen: result.refundFen,
        channelState: result.channelState ?? null,
        channelRefundNo: result.channelRefundNo ?? null,
      }),
    );
  } catch (error: unknown) {
    // A conflict: another judgement moved the refund first; the job fails and the queue may run
    // it again (then it finds the refund decided and asks nothing). Any other error fails as is.
    if (error instanceof PayRefundConflict) {
      deps.logger.warn({ ...base, pay_channel: channel }, 'pay_refund_query_conflict');
    }
    throw error;
  }
  switch (outcome.verdict.kind) {
    case 'rejected':
      deps.logger.warn(
        { ...base, pay_channel: channel, reason: 'identity_not_ours' },
        'pay_refund_query_rejected',
      );
      await scheduleNextRefundQuery(deps, refund, now);
      return;
    case 'mismatch':
      // 任一项不符或状态不在清单内 → 不迁移、继续占用额度、记录并告警 (BR-PAY-06 ④).
      deps.logger.warn(
        { ...base, pay_channel: channel, reason: outcome.verdict.reason },
        'pay_refund_query_mismatch',
      );
      await scheduleNextRefundQuery(deps, refund, now);
      return;
    case 'succeed':
    case 'fail':
    case 'already_final':
      deps.logger.info(
        { ...base, pay_channel: channel, result: outcome.verdict.kind },
        'pay_refund_query_handled',
      );
      return;
  }
}
