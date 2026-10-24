// B2-15e unit tests of the pure refund pieces (08 BR-PAY-06 ② ④ ⑤ and 细则): the fixed order of
// the result checks, the state lists, the refund number and the query rhythm. The rule tests in
// test/spec/payment/refund/** are the acceptance; these pin the implementation's own choices.
import { describe, expect, it } from 'vitest';
import {
  REFUND_QUERY_SCHEDULE_SECONDS,
  generateOutRefundNo,
  nextRefundQueryInstant,
  refundQuerySlotSeconds,
} from './out-refund-no.ts';
import { judgeRefundResult, refundStatesOf, type RefundResultFacts } from './pay-refund.ts';

const ours: RefundResultFacts = {
  ours: true,
  refund: {
    status: 'PROCESSING',
    payChannel: 'wechat_pay',
    amountFen: 5_000n,
    targetOutTradeNo: 'P0000000000000000000A',
    targetChannelTradeNo: '4200000000000000000000000001',
  },
  channel: 'wechat_pay',
  outTradeNo: 'P0000000000000000000A',
  channelTradeNo: '4200000000000000000000000001',
  refundFen: 5_000n,
  channelState: 'SUCCESS',
  successStates: ['SUCCESS'],
  failStates: [],
};

describe('[AC-B2-15e] judgeRefundResult', () => {
  it('[AC-B2-15e#1] moves a PROCESSING refund only when every check passes, in the fixed order', () => {
    expect(judgeRefundResult(ours)).toEqual({ kind: 'succeed' });
    expect(judgeRefundResult({ ...ours, ours: false })).toEqual({ kind: 'rejected' });
    expect(judgeRefundResult({ ...ours, refund: null })).toEqual({
      kind: 'mismatch',
      reason: 'refund_not_found',
    });
    // The original: one differing pair decides, even when the other pair matches.
    expect(judgeRefundResult({ ...ours, channelTradeNo: '4200000000000000000000000002' })).toEqual({
      kind: 'mismatch',
      reason: 'original_mismatch',
    });
    // An anomaly receipt without a merchant number: the channel trade number alone compares.
    expect(
      judgeRefundResult({
        ...ours,
        outTradeNo: null,
        refund: { ...ours.refund!, targetOutTradeNo: null },
      }),
    ).toEqual({ kind: 'succeed' });
    // Nothing comparable at all is a mismatch, never a pass.
    expect(
      judgeRefundResult({
        ...ours,
        outTradeNo: null,
        channelTradeNo: null,
      }),
    ).toEqual({ kind: 'mismatch', reason: 'original_mismatch' });
    expect(judgeRefundResult({ ...ours, channel: 'alipay' })).toEqual({
      kind: 'mismatch',
      reason: 'channel_mismatch',
    });
    expect(judgeRefundResult({ ...ours, refundFen: 4_999n })).toEqual({
      kind: 'mismatch',
      reason: 'amount_mismatch',
    });
    expect(judgeRefundResult({ ...ours, refundFen: null })).toEqual({
      kind: 'mismatch',
      reason: 'amount_mismatch',
    });
    expect(judgeRefundResult({ ...ours, channelState: 'CLOSED' })).toEqual({
      kind: 'mismatch',
      reason: 'state_not_listed',
    });
    expect(judgeRefundResult({ ...ours, channelState: null })).toEqual({
      kind: 'mismatch',
      reason: 'state_not_listed',
    });
    expect(judgeRefundResult({ ...ours, channelState: 'CLOSED', failStates: ['CLOSED'] })).toEqual({
      kind: 'fail',
    });
  });

  it('[AC-B2-15e#1] never moves a decided refund: SUCCESS and FAILED answer already_final', () => {
    for (const status of ['SUCCESS', 'FAILED'] as const) {
      const refund = { ...ours.refund!, status };
      expect(judgeRefundResult({ ...ours, refund })).toEqual({ kind: 'already_final' });
      expect(
        judgeRefundResult({ ...ours, refund, channelState: 'CLOSED', failStates: ['CLOSED'] }),
      ).toEqual({ kind: 'already_final' });
      // A mismatch is reported as such, whatever the status.
      expect(judgeRefundResult({ ...ours, refund, refundFen: 1n })).toEqual({
        kind: 'mismatch',
        reason: 'amount_mismatch',
      });
    }
  });
});

describe('[AC-B2-15e] refundStatesOf', () => {
  it('[AC-B2-15e#2] defaults: the documented success state only, no failure state before a tested sample', () => {
    expect(refundStatesOf('wechat_pay', 'success', undefined)).toEqual({
      states: ['SUCCESS'],
      fallback: false,
    });
    expect(refundStatesOf('alipay', 'success', null)).toEqual({
      states: ['REFUND_SUCCESS'],
      fallback: false,
    });
    expect(refundStatesOf('alipay', 'fail', undefined)).toEqual({ states: [], fallback: false });
  });

  it('[AC-B2-15e#2] takes a valid list as configured and falls back, flagged, on anything else', () => {
    expect(refundStatesOf('wechat_pay', 'fail', ['CLOSED'])).toEqual({
      states: ['CLOSED'],
      fallback: false,
    });
    expect(refundStatesOf('wechat_pay', 'fail', [])).toEqual({ states: [], fallback: false });
    expect(refundStatesOf('wechat_pay', 'success', [])).toEqual({
      states: ['SUCCESS'],
      fallback: true,
    });
    expect(refundStatesOf('alipay', 'success', 'REFUND_SUCCESS')).toEqual({
      states: ['REFUND_SUCCESS'],
      fallback: true,
    });
    expect(refundStatesOf('alipay', 'fail', [1])).toEqual({ states: [], fallback: true });
  });
});

describe('[AC-B2-15e] out_refund_no and the query rhythm', () => {
  it('[AC-B2-15e#4] generates R + 20 upper-case letters or digits, fresh every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const no = generateOutRefundNo();
      expect(no).toMatch(/^R[0-9A-Z]{20}$/);
      seen.add(no);
    }
    expect(seen.size).toBe(200);
  });

  it('[AC-B2-15e#12] plans the next slot strictly after now relative to the creation, then nothing', () => {
    const createdAt = new Date('2026-10-25T01:00:00.000Z');
    expect(REFUND_QUERY_SCHEDULE_SECONDS[0]).toBe(60);
    const first = nextRefundQueryInstant(createdAt, createdAt);
    expect(first?.toISOString()).toBe('2026-10-25T01:01:00.000Z');
    expect(refundQuerySlotSeconds(createdAt, first!)).toBe(60);
    const atFirst = nextRefundQueryInstant(createdAt, first!);
    expect(refundQuerySlotSeconds(createdAt, atFirst!)).toBe(300);
    const late = new Date(createdAt.getTime() + 86_400_000);
    expect(nextRefundQueryInstant(createdAt, late)).toBeNull();
    // The given instant is never modified.
    expect(createdAt.toISOString()).toBe('2026-10-25T01:00:00.000Z');
  });
});
