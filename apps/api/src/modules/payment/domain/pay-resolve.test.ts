// B2-15f unit tests of the manual settlement's pure part (domain/pay-resolve.ts; 08 BR-PAY-05 ②③;
// contract AdminPayChannelResult).
import { describe, expect, it } from 'vitest';
import { channelResultOf, resolvePlanOf, type ResolveQueryAnswer } from './pay-resolve.ts';

function ok(
  state: 'paid' | 'not_paid' | 'closed' | 'not_exist',
  channelState: string | null = null,
  channelTradeNo: string | null = null,
): ResolveQueryAnswer {
  return { kind: 'ok', state, channelState, channelTradeNo };
}

const UNKNOWN: ResolveQueryAnswer = { kind: 'unknown' };

describe('resolvePlanOf', () => {
  it('[AC-B2-15f#u1] paid is judged, closed closes, unknown and not paid keep the order', () => {
    expect(resolvePlanOf(ok('paid', 'SUCCESS', 'T1'), false)).toEqual({ kind: 'judge_paid' });
    expect(resolvePlanOf(ok('closed', 'CLOSED'), false)).toEqual({
      kind: 'close',
      basis: 'channel_closed',
    });
    expect(resolvePlanOf(ok('not_paid', 'NOTPAY'), true)).toEqual({ kind: 'keep' });
    expect(resolvePlanOf(UNKNOWN, true)).toEqual({ kind: 'keep' });
  });

  it('[AC-B2-15f#u2] not exist closes only under the BR-PAY-05 ② condition', () => {
    expect(resolvePlanOf(ok('not_exist'), true)).toEqual({
      kind: 'close',
      basis: 'not_exist_after_grace',
    });
    expect(resolvePlanOf(ok('not_exist'), false)).toEqual({ kind: 'keep' });
  });
});

describe('channelResultOf', () => {
  it('[AC-B2-15f#u3] paid only when settled; a paid answer failing the checks is unknown', () => {
    expect(channelResultOf(ok('paid', 'SUCCESS', 'T1'), true)).toEqual({
      state: 'paid',
      channelState: 'SUCCESS',
      channelTradeNo: 'T1',
    });
    expect(channelResultOf(ok('paid', 'SUCCESS', 'T1'), false)).toEqual({
      state: 'unknown',
      channelState: 'SUCCESS',
      channelTradeNo: 'T1',
    });
  });

  it('[AC-B2-15f#u4] closed and not exist as answered; not paid and unknown read unknown', () => {
    expect(channelResultOf(ok('closed', 'TRADE_CLOSED'), false)).toEqual({
      state: 'closed',
      channelState: 'TRADE_CLOSED',
      channelTradeNo: null,
    });
    expect(channelResultOf(ok('not_exist'), false)).toEqual({
      state: 'not_exist',
      channelState: null,
      channelTradeNo: null,
    });
    expect(channelResultOf(ok('not_paid', 'WAIT_BUYER_PAY'), false)).toEqual({
      state: 'unknown',
      channelState: 'WAIT_BUYER_PAY',
      channelTradeNo: null,
    });
    expect(channelResultOf(UNKNOWN, false)).toEqual({
      state: 'unknown',
      channelState: null,
      channelTradeNo: null,
    });
  });
});
