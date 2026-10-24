// B2-15c rule tests without a database (claude-independent, SPEC_REF ec81e625): 08 BR-PAY-04
// (核对表、成功状态清单、查询节奏), BR-PAY-05 ④ (CLOSED 单或找不到支付单的收款 → 异常收款);
// task §9.3 (核对顺序固定 ①②③④), §9.5 (pay.query_schedule), §9.6.
// Top-level it() only (规划/11 §4.3).
import fc from 'fast-check';
import { propParams } from '@couli/testing';
import { expect, it } from 'vitest';
import {
  judgePayResult,
  queryInstants,
  queryScheduleOf,
  successStatesOf,
  type PayResultFacts,
  type PayResultVerdict,
} from '../../../../apps/api/src/modules/payment/domain/pay-result.ts';
import type { PayOrderStatus } from '../../../../apps/api/src/modules/payment/domain/types.ts';

/** The rule of BR-PAY-04 / BR-PAY-05 ④ in the fixed order ① ② ③ ④ (task §9.3), as an oracle. */
function oracle(facts: PayResultFacts): PayResultVerdict {
  if (!facts.ours) return { kind: 'rejected' };
  const listed = facts.successStates.includes(facts.channelState);
  if (facts.order === null) {
    return listed
      ? { kind: 'anomaly', orderFound: false }
      : { kind: 'mismatch', reason: 'order_not_found' };
  }
  if (facts.amountFen !== facts.order.amountFen)
    return { kind: 'mismatch', reason: 'amount_mismatch' };
  if (!listed) return { kind: 'mismatch', reason: 'state_not_success' };
  if (facts.order.status === 'PENDING') return { kind: 'settle' };
  if (facts.order.status === 'PAID') return { kind: 'already_paid' };
  return { kind: 'anomaly', orderFound: true };
}

const BASE: PayResultFacts = {
  ours: true,
  order: { status: 'PENDING', amountFen: 12_345n },
  amountFen: 12_345n,
  channelState: 'SUCCESS',
  successStates: ['SUCCESS'],
};

it('[AC-B2-15c#1] 核对表逐项：标识不是我方 → 拒绝；找不到单 / 金额不符 / 状态不在清单 → 不迁移；全部通过按单状态 PENDING 迁移、PAID 不重复、CLOSED 异常收款', () => {
  const cases: [string, PayResultFacts, PayResultVerdict][] = [
    ['全部通过的 PENDING 单', BASE, { kind: 'settle' }],
    ['标识不是我方', { ...BASE, ours: false }, { kind: 'rejected' }],
    [
      '标识不是我方时其余各项也不看',
      { ...BASE, ours: false, order: null, amountFen: 1n, channelState: 'NOTPAY' },
      { kind: 'rejected' },
    ],
    [
      '金额少一分',
      { ...BASE, amountFen: 12_344n },
      { kind: 'mismatch', reason: 'amount_mismatch' },
    ],
    [
      '金额多一分',
      { ...BASE, amountFen: 12_346n },
      { kind: 'mismatch', reason: 'amount_mismatch' },
    ],
    [
      '状态不在清单',
      { ...BASE, channelState: 'NOTPAY' },
      { kind: 'mismatch', reason: 'state_not_success' },
    ],
    [
      '状态大小写不同不算',
      { ...BASE, channelState: 'success' },
      { kind: 'mismatch', reason: 'state_not_success' },
    ],
    [
      '支付宝交易完成在清单之外（BR-PAY-04 细则）',
      {
        ...BASE,
        channelState: 'TRADE_FINISHED',
        successStates: ['TRADE_SUCCESS'],
      },
      { kind: 'mismatch', reason: 'state_not_success' },
    ],
    [
      '清单被配置覆盖后照清单判定',
      {
        ...BASE,
        channelState: 'TRADE_FINISHED',
        successStates: ['TRADE_SUCCESS', 'TRADE_FINISHED'],
      },
      { kind: 'settle' },
    ],
    [
      '已 PAID 的单',
      { ...BASE, order: { status: 'PAID', amountFen: 12_345n } },
      { kind: 'already_paid' },
    ],
    [
      'CLOSED 的单：不迁移，异常收款',
      { ...BASE, order: { status: 'CLOSED', amountFen: 12_345n } },
      { kind: 'anomaly', orderFound: true },
    ],
    [
      'CLOSED 的单金额不符：不是异常收款，按不符处理',
      { ...BASE, order: { status: 'CLOSED', amountFen: 12_345n }, amountFen: 100n },
      { kind: 'mismatch', reason: 'amount_mismatch' },
    ],
    [
      'CLOSED 的单状态不在清单：不是收款',
      { ...BASE, order: { status: 'CLOSED', amountFen: 12_345n }, channelState: 'CLOSED' },
      { kind: 'mismatch', reason: 'state_not_success' },
    ],
    [
      '找不到支付单但渠道状态是成功：异常收款',
      { ...BASE, order: null },
      { kind: 'anomaly', orderFound: false },
    ],
    [
      '找不到支付单且状态不是成功：不符',
      { ...BASE, order: null, channelState: 'NOTPAY' },
      { kind: 'mismatch', reason: 'order_not_found' },
    ],
    [
      '金额先于状态核对（顺序 ③ 在 ④ 前）',
      { ...BASE, amountFen: 1n, channelState: 'NOTPAY' },
      { kind: 'mismatch', reason: 'amount_mismatch' },
    ],
    [
      '空清单下没有任何状态算成功',
      { ...BASE, successStates: [] },
      { kind: 'mismatch', reason: 'state_not_success' },
    ],
  ];
  for (const [name, facts, verdict] of cases) {
    expect(judgePayResult(facts), name).toEqual(verdict);
  }
});

it('[AC-B2-15c#2] 属性：任意核对事实下判定都等于按 ①②③④ 固定顺序逐项核对的结果，且只有 PENDING 单全部通过才迁移', () => {
  const states = ['SUCCESS', 'TRADE_SUCCESS', 'TRADE_FINISHED', 'NOTPAY', 'CLOSED', 'success', ''];
  const statuses: PayOrderStatus[] = ['PENDING', 'PAID', 'CLOSED'];
  const amount = fc.bigInt({ min: 1n, max: 9_999_999_999n });
  const facts = fc.record({
    ours: fc.boolean(),
    order: fc.option(fc.record({ status: fc.constantFrom(...statuses), amountFen: amount }), {
      nil: null,
    }),
    amountFen: amount,
    channelState: fc.constantFrom(...states),
    successStates: fc.subarray(states),
  });
  fc.assert(
    fc.property(facts, fc.boolean(), (generated, sameAmount) => {
      const input: PayResultFacts =
        sameAmount && generated.order !== null
          ? { ...generated, amountFen: generated.order.amountFen }
          : generated;
      const verdict = judgePayResult(input);
      expect(verdict).toEqual(oracle(input));
      if (verdict.kind === 'settle') {
        expect(input.ours).toBe(true);
        expect(input.order?.status).toBe('PENDING');
        expect(input.amountFen).toBe(input.order?.amountFen);
        expect(input.successStates).toContain(input.channelState);
      }
    }),
    propParams(),
  );
});

it('[AC-B2-15c#3] pay.<pay_channel>.success_states：缺省只含官方成功状态（微信 SUCCESS、支付宝 TRADE_SUCCESS，不含 TRADE_FINISHED）；合法数组照用；其他值回默认并标记告警', () => {
  expect(successStatesOf('wechat_pay', null)).toEqual({ states: ['SUCCESS'], fallback: false });
  expect(successStatesOf('wechat_pay', undefined)).toEqual({
    states: ['SUCCESS'],
    fallback: false,
  });
  expect(successStatesOf('alipay', null)).toEqual({ states: ['TRADE_SUCCESS'], fallback: false });
  expect(successStatesOf('alipay', null).states).not.toContain('TRADE_FINISHED');
  expect(successStatesOf('alipay', ['TRADE_SUCCESS', 'TRADE_FINISHED'])).toEqual({
    states: ['TRADE_SUCCESS', 'TRADE_FINISHED'],
    fallback: false,
  });
  expect(successStatesOf('wechat_pay', ['SUCCESS'])).toEqual({
    states: ['SUCCESS'],
    fallback: false,
  });
  for (const raw of ['SUCCESS', [], [''], [1], ['SUCCESS', 2], {}, true, 0, [null]]) {
    expect(successStatesOf('wechat_pay', raw), JSON.stringify(raw)).toEqual({
      states: ['SUCCESS'],
      fallback: true,
    });
    expect(successStatesOf('alipay', raw), JSON.stringify(raw)).toEqual({
      states: ['TRADE_SUCCESS'],
      fallback: true,
    });
  }
});

it('[AC-B2-15c#4] pay.query_schedule：缺省为创建后 10 秒、30 秒、1 分、3 分、10 分；合法秒数数组照用；其他值回默认并标记告警', () => {
  const defaults = [10, 30, 60, 180, 600];
  expect(queryScheduleOf(null)).toEqual({ seconds: defaults, fallback: false });
  expect(queryScheduleOf(undefined)).toEqual({ seconds: defaults, fallback: false });
  expect(queryScheduleOf([5, 20])).toEqual({ seconds: [5, 20], fallback: false });
  expect(queryScheduleOf([1])).toEqual({ seconds: [1], fallback: false });
  for (const raw of [[], [0], [-10], [1.5], ['10'], [10, 10], [30, 10], '10', 10, {}, true]) {
    expect(queryScheduleOf(raw), JSON.stringify(raw)).toEqual({
      seconds: defaults,
      fallback: true,
    });
  }
});

it('[AC-B2-15c#5] 查询时点：创建时刻加各档秒数中早于 expire_at 的，再加 expire_at 一次，升序、精确到毫秒', () => {
  const created = new Date('2026-10-22T01:00:00.123Z');
  const at = (ms: number) => new Date(created.getTime() + ms).toISOString();
  const run = (ttlMs: number, seconds: readonly number[]) =>
    queryInstants(created, new Date(created.getTime() + ttlMs), seconds).map((d) =>
      d.toISOString(),
    );
  const defaults = [10, 30, 60, 180, 600];
  expect(run(15 * 60_000, defaults)).toEqual([
    at(10_000),
    at(30_000),
    at(60_000),
    at(180_000),
    at(600_000),
    at(900_000),
  ]);
  expect(run(2 * 60_000, defaults)).toEqual([at(10_000), at(30_000), at(60_000), at(120_000)]);
  // A slot at expire_at itself is the expire_at query (once).
  expect(run(2 * 60_000, [60, 120])).toEqual([at(60_000), at(120_000)]);
  expect(run(5_000, defaults)).toEqual([at(5_000)]);
  expect(run(15 * 60_000, [5, 20])).toEqual([at(5_000), at(20_000), at(900_000)]);
  expect(created.toISOString()).toBe('2026-10-22T01:00:00.123Z');
});
