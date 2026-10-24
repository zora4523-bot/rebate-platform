// B2-15e pure rule tests (claude-independent, SPEC_REF c4cfc1a2): 08 BR-PAY-06 ④ (核对顺序：应用与商户
// 标识 → 退款单号 → 原支付单号或渠道交易号 → 渠道 → 金额 → 状态清单；任一不符不迁移) and 细则
// (refund_success_states 验证前只含官方文档写明的退款成功状态，refund_fail_states 验证前为空);
// 规划/04 §5「幂等」后台账号的幂等主体 a:<admin_user_id>（D10-168 ②）. The skeleton's contract is the
// header of apps/api/src/modules/payment/domain/pay-refund.ts. Property bodies return a boolean and
// are asserted once outside fc.check. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import fc from 'fast-check';
import { propParams } from '@couli/testing';
import { expect, it } from 'vitest';
import {
  judgeRefundResult,
  refundStatesOf,
  type RefundResultFacts,
  type RefundResultRefund,
  type RefundResultVerdict,
} from '../../../../apps/api/src/modules/payment/domain/pay-refund.ts';
import type {
  PayChannelCode,
  PayRefundStatus,
} from '../../../../apps/api/src/modules/payment/domain/types.ts';
import {
  IdempotencyError,
  subjectOf,
} from '../../../../apps/api/src/modules/platform/idempotency/index.ts';

/** How a synchronous call ended: its value, or the error's name and code / message. */
function outcome(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    if (error instanceof IdempotencyError) return `IdempotencyError ${error.code}`;
    return error instanceof Error ? `${error.name}: ${error.message}` : `thrown ${String(error)}`;
  }
}

/** BR-PAY-06 ④ ③: at least one compared pair, every compared pair equal. */
function originalMatches(facts: RefundResultFacts, refund: RefundResultRefund): boolean {
  const pairs: readonly (readonly [string | null, string | null])[] = [
    [facts.outTradeNo, refund.targetOutTradeNo],
    [facts.channelTradeNo, refund.targetChannelTradeNo],
  ];
  const compared = pairs.filter(([reported, ours]) => reported !== null && ours !== null);
  return compared.length > 0 && compared.every(([reported, ours]) => reported === ours);
}

/** The rule in the fixed order ① ～ ⑥, as an oracle. */
function oracle(facts: RefundResultFacts): RefundResultVerdict {
  if (!facts.ours) return { kind: 'rejected' };
  const refund = facts.refund;
  if (refund === null) return { kind: 'mismatch', reason: 'refund_not_found' };
  if (!originalMatches(facts, refund)) return { kind: 'mismatch', reason: 'original_mismatch' };
  if (facts.channel !== refund.payChannel) return { kind: 'mismatch', reason: 'channel_mismatch' };
  if (facts.refundFen === null || facts.refundFen !== refund.amountFen) {
    return { kind: 'mismatch', reason: 'amount_mismatch' };
  }
  const state = facts.channelState;
  if (state !== null && facts.successStates.includes(state)) {
    return refund.status === 'PROCESSING' ? { kind: 'succeed' } : { kind: 'already_final' };
  }
  if (state !== null && facts.failStates.includes(state)) {
    return refund.status === 'PROCESSING' ? { kind: 'fail' } : { kind: 'already_final' };
  }
  return { kind: 'mismatch', reason: 'state_not_listed' };
}

const CHANNEL_CODES: readonly PayChannelCode[] = ['wechat_pay', 'alipay'];
const STATUSES: readonly PayRefundStatus[] = ['PROCESSING', 'SUCCESS', 'FAILED'];
/** Documented and undocumented refund states of both channels, and look-alikes. */
const STATES = [
  'SUCCESS',
  'REFUND_SUCCESS',
  'PROCESSING',
  'ABNORMAL',
  'CLOSED',
  'TRADE_CLOSED',
  'success',
  '',
];
/** Small pools, so that reported and stored numbers often coincide. */
const OUT_TRADE_NOS = ['P0000000000000000000A', 'P0000000000000000000B'];
const TRADE_NOS = ['4200000000000000000000000001', '2026102522001400000000000002'];
const LARGE = 2n ** 31n;
const MAX = 9_999_999_999n;

/** A refund amount of ours: at least 1 fen (pay_refunds_amount_fen_check). */
const stored = fc.oneof(
  fc.constantFrom(1n, 3n, LARGE - 1n, LARGE + 1n),
  fc.bigInt({ min: 1n, max: MAX }),
);
/** A reported refund amount: 0 fen, 1, odd values and values past 2^31 in reach. */
const reported = fc.oneof(
  fc.constantFrom(0n, 1n, 3n, LARGE - 1n, LARGE, LARGE + 1n),
  fc.bigInt({ min: 0n, max: MAX }),
);
/** How the reported amount relates to ours. */
type Relation = 'free' | 'same' | 'below' | 'above' | 'absent';

function aligned(
  generated: RefundResultFacts,
  relation: Relation,
  sameOriginal: boolean,
): RefundResultFacts {
  let facts = generated;
  const refund = facts.refund;
  if (relation === 'absent') facts = { ...facts, refundFen: null };
  if (refund !== null && relation !== 'free' && relation !== 'absent') {
    const ours = refund.amountFen;
    facts = {
      ...facts,
      refundFen: relation === 'same' ? ours : relation === 'below' ? ours - 1n : ours + 1n,
    };
  }
  if (refund !== null && sameOriginal) {
    facts = {
      ...facts,
      channel: refund.payChannel,
      outTradeNo: refund.targetOutTradeNo,
      channelTradeNo: refund.targetChannelTradeNo,
    };
  }
  // A state listed as both success and failure is a configuration error this property leaves out.
  return {
    ...facts,
    failStates: facts.failStates.filter((state) => !facts.successStates.includes(state)),
  };
}

/** The verdict is the oracle's; only a PROCESSING refund that passes every check moves. */
function holds(generated: RefundResultFacts, relation: Relation, sameOriginal: boolean): boolean {
  const input = aligned(generated, relation, sameOriginal);
  let verdict: RefundResultVerdict;
  try {
    verdict = judgeRefundResult(input);
  } catch {
    return false;
  }
  const moves = verdict.kind === 'succeed' || verdict.kind === 'fail';
  const refund = input.refund;
  return (
    isDeepStrictEqual(verdict, oracle(input)) &&
    (!moves ||
      (input.ours &&
        refund !== null &&
        refund.status === 'PROCESSING' &&
        refund.payChannel === input.channel &&
        input.refundFen === refund.amountFen &&
        originalMatches(input, refund) &&
        input.channelState !== null &&
        (verdict.kind === 'succeed'
          ? input.successStates.includes(input.channelState)
          : input.failStates.includes(input.channelState))))
  );
}

it('[AC-B2-15e#1] 属性（布尔属性体、在 fc.check 外断言一次）：退款结果判定等于按 BR-PAY-06 ④ 固定顺序（标识 → 退款单号 → 原单 → 渠道 → 金额 → 状态清单）逐项核对的结果；只有 PROCESSING 且全部通过才迁移，SUCCESS / FAILED 不再迁移；金额覆盖缺省、0 分、差一分与 2^31 以上', () => {
  const original = fc.option(fc.constantFrom(...OUT_TRADE_NOS), { nil: null });
  const trade = fc.option(fc.constantFrom(...TRADE_NOS), { nil: null });
  const refund = fc.record({
    status: fc.constantFrom(...STATUSES),
    payChannel: fc.constantFrom(...CHANNEL_CODES),
    amountFen: stored,
    targetOutTradeNo: original,
    targetChannelTradeNo: trade,
  });
  const facts = fc.record({
    ours: fc.boolean(),
    refund: fc.option(refund, { nil: null }),
    channel: fc.constantFrom(...CHANNEL_CODES),
    outTradeNo: original,
    channelTradeNo: trade,
    refundFen: fc.option(reported, { nil: null }),
    channelState: fc.option(fc.constantFrom(...STATES), { nil: null }),
    successStates: fc.subarray(STATES),
    failStates: fc.subarray(STATES),
  });
  const relation = fc.constantFrom<Relation>('free', 'same', 'below', 'above', 'absent');
  const details = fc.check(fc.property(facts, relation, fc.boolean(), holds), propParams());
  expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
});

it('[AC-B2-15e#2] pay.<pay_channel>.refund_success_states / refund_fail_states：缺省成功清单只含官方文档写明的退款成功状态（微信 SUCCESS、支付宝 REFUND_SUCCESS），失败清单验证前为空；合法配置照用（失败清单可为空数组）；其他值回默认并标记告警', () => {
  type Case = readonly [PayChannelCode, 'success' | 'fail', unknown, readonly string[], boolean];
  const cases: readonly Case[] = [
    ['wechat_pay', 'success', undefined, ['SUCCESS'], false],
    ['wechat_pay', 'success', null, ['SUCCESS'], false],
    ['alipay', 'success', undefined, ['REFUND_SUCCESS'], false],
    ['alipay', 'success', null, ['REFUND_SUCCESS'], false],
    ['wechat_pay', 'fail', undefined, [], false],
    ['alipay', 'fail', null, [], false],
    ['wechat_pay', 'success', ['SUCCESS', 'REFUND_DONE'], ['SUCCESS', 'REFUND_DONE'], false],
    ['alipay', 'success', ['REFUND_SUCCESS'], ['REFUND_SUCCESS'], false],
    ['wechat_pay', 'fail', ['CLOSED'], ['CLOSED'], false],
    ['alipay', 'fail', ['REFUND_FAIL', 'REFUND_CLOSED'], ['REFUND_FAIL', 'REFUND_CLOSED'], false],
    ['wechat_pay', 'fail', [], [], false],
    ['wechat_pay', 'success', [], ['SUCCESS'], true],
    ['alipay', 'success', 'REFUND_SUCCESS', ['REFUND_SUCCESS'], true],
    ['wechat_pay', 'success', [''], ['SUCCESS'], true],
    ['wechat_pay', 'success', ['SUCCESS', 1], ['SUCCESS'], true],
    ['alipay', 'success', { states: ['REFUND_SUCCESS'] }, ['REFUND_SUCCESS'], true],
    ['wechat_pay', 'fail', 'CLOSED', [], true],
    ['alipay', 'fail', [''], [], true],
    ['alipay', 'fail', [false], [], true],
  ];
  for (const [channel, list, raw, states, fallback] of cases) {
    expect(
      outcome(() => refundStatesOf(channel, list, raw)),
      `${channel} ${list} ${JSON.stringify(raw)}`,
    ).toEqual({ states, fallback });
  }
});

it('[AC-B2-15e#3] 后台账号的幂等主体为 a:<admin_user_id>（04 §5，D10-168 ②）：只有 adminUserId 时得 a: 主体；格式不对拒绝 invalid_subject；不带 adminUserId 时原有三种主体不变', () => {
  const admin = randomUUID();
  const user = randomUUID();
  const none = { userId: null, deviceId: null, phoneHmac: null };
  expect(outcome(() => subjectOf({ ...none, adminUserId: admin }))).toBe(`a:${admin}`);
  expect(outcome(() => subjectOf({ ...none, adminUserId: admin.toUpperCase() }))).toBe(
    'IdempotencyError invalid_subject',
  );
  expect(outcome(() => subjectOf({ ...none, adminUserId: `${admin}\n` }))).toBe(
    'IdempotencyError invalid_subject',
  );
  expect(outcome(() => subjectOf({ ...none, adminUserId: null }))).toBe(
    'IdempotencyError invalid_subject',
  );
  expect(outcome(() => subjectOf({ ...none, userId: user }))).toBe(`u:${user}`);
  expect(outcome(() => subjectOf({ ...none, userId: user, adminUserId: null }))).toBe(`u:${user}`);
});
