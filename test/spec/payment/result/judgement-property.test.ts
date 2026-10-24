// B2-15c judgement property, round 2 (claude-independent, SPEC_REF ec81e625): 08 BR-PAY-04 (核对表
// ①②③④、任一不符不迁移), BR-PAY-05 ④; task §9.3. Rule-test review r1 S2: the property body returns a
// boolean and the result is asserted once outside fc.check; the channel's amount includes 0 fen,
// 1, odd values and values past 2^31 (our amount_fen is at least 1, pay_orders_amount_fen_check).
// domain.test.ts is frozen at the spec commit, so this is a file of its own.
// Top-level it() only (规划/11 §4.3).
import { isDeepStrictEqual } from 'node:util';
import fc from 'fast-check';
import { propParams } from '@couli/testing';
import { expect, it } from 'vitest';
import {
  judgePayResult,
  type PayResultFacts,
  type PayResultVerdict,
} from '../../../../apps/api/src/modules/payment/domain/pay-result.ts';
import type { PayOrderStatus } from '../../../../apps/api/src/modules/payment/domain/types.ts';

/** The rule in the fixed order ① ② ③ ④ (task §9.3), as an oracle. */
function oracle(facts: PayResultFacts): PayResultVerdict {
  if (!facts.ours) return { kind: 'rejected' };
  const listed = facts.successStates.includes(facts.channelState);
  if (facts.order === null) {
    return listed
      ? { kind: 'anomaly', orderFound: false }
      : { kind: 'mismatch', reason: 'order_not_found' };
  }
  if (facts.amountFen !== facts.order.amountFen) {
    return { kind: 'mismatch', reason: 'amount_mismatch' };
  }
  if (!listed) return { kind: 'mismatch', reason: 'state_not_success' };
  if (facts.order.status === 'PENDING') return { kind: 'settle' };
  if (facts.order.status === 'PAID') return { kind: 'already_paid' };
  return { kind: 'anomaly', orderFound: true };
}

const STATES = ['SUCCESS', 'TRADE_SUCCESS', 'TRADE_FINISHED', 'NOTPAY', 'CLOSED', 'success', ''];
const STATUSES: readonly PayOrderStatus[] = ['PENDING', 'PAID', 'CLOSED'];
const LARGE = 2n ** 31n;
const MAX = 9_999_999_999n;

/** The channel's reported total: 0 fen, 1, odd values and values past 2^31 always in reach. */
const reported = fc.oneof(
  fc.constantFrom(0n, 1n, 3n, LARGE - 1n, LARGE, LARGE + 1n),
  fc.bigInt({ min: 0n, max: MAX }),
);
/** Our amount_fen: at least 1 fen. */
const stored = fc.oneof(
  fc.constantFrom(1n, 3n, LARGE - 1n, LARGE + 1n),
  fc.bigInt({ min: 1n, max: MAX }),
);
/** How the reported amount relates to ours: unrelated, equal, one fen less, one fen more. */
type Relation = 'free' | 'same' | 'below' | 'above';

function aligned(generated: PayResultFacts, relation: Relation): PayResultFacts {
  if (generated.order === null || relation === 'free') return generated;
  const ours = generated.order.amountFen;
  const amountFen = relation === 'same' ? ours : relation === 'below' ? ours - 1n : ours + 1n;
  return { ...generated, amountFen };
}

/** The verdict is the oracle's, and only a PENDING order that passes every check settles. */
function holds(generated: PayResultFacts, relation: Relation): boolean {
  const input = aligned(generated, relation);
  const verdict = judgePayResult(input);
  const settles = verdict.kind === 'settle';
  return (
    isDeepStrictEqual(verdict, oracle(input)) &&
    (!settles ||
      (input.ours &&
        input.order?.status === 'PENDING' &&
        input.amountFen === input.order.amountFen &&
        input.successStates.includes(input.channelState)))
  );
}

it('[AC-B2-15c#30] 属性（布尔属性体、在 fc.check 外断言一次）：任意核对事实下判定都等于按 ①②③④ 固定顺序逐项核对的结果，只有 PENDING 单全部通过才迁移；渠道金额覆盖 0 分、1、奇数与 2^31 以上，含与 amount_fen 差一分', () => {
  const facts = fc.record({
    ours: fc.boolean(),
    order: fc.option(fc.record({ status: fc.constantFrom(...STATUSES), amountFen: stored }), {
      nil: null,
    }),
    amountFen: reported,
    channelState: fc.constantFrom(...STATES),
    successStates: fc.subarray(STATES),
  });
  const relation = fc.constantFrom<Relation>('free', 'same', 'below', 'above');
  const details = fc.check(fc.property(facts, relation, holds), propParams());
  expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
});
