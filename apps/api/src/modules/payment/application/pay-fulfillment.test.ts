// B2-15c unit tests of the entitlement rule (BR-PAY-01 细则: recomputed from the paid and refunded
// facts, D10-168) and of the fake channel's identity resolution (BR-PAY-04 核对 ①).
import { describe, expect, it } from 'vitest';
import { FakePayChannel } from '../infra/channels/fake-pay-channel.ts';
import { fulfillmentStateOf } from './pay-fulfillment.ts';

describe('[AC-B2-15c] fulfilment state', () => {
  it('[AC-B2-15c#25] none without a PAID order, active while not refunded in full, revoked once it is', () => {
    expect(fulfillmentStateOf(null)).toBe('none');
    expect(fulfillmentStateOf({ amountFen: 12_345n, refundedFen: 0n })).toBe('active');
    expect(fulfillmentStateOf({ amountFen: 12_345n, refundedFen: 12_344n })).toBe('active');
    expect(fulfillmentStateOf({ amountFen: 12_345n, refundedFen: 12_345n })).toBe('revoked');
  });
});

describe('[AC-B2-15c] FakePayChannel identities', () => {
  it("[AC-B2-15c#10] resolves only registered identities, each to its app; a half-matching one is nobody's", () => {
    const channel = new FakePayChannel('alipay');
    const a = channel.own('app_a');
    const b = channel.own('app_b');
    expect(channel.ownerAppOf(a)).toBe('app_a');
    expect(channel.ownerAppOf(b)).toBe('app_b');
    expect(channel.ownerAppOf({ merchantRef: a.merchantRef, appRef: b.appRef })).toBeNull();
    expect(channel.ownerAppOf({ merchantRef: 'x', appRef: 'y' })).toBeNull();
    expect(a).not.toEqual(b);
  });
});
