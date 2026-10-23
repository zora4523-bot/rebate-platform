import { expect, it, vi } from 'vitest';
import {
  ChannelDisabledError,
  PayoutModeMustBeDryRunError,
} from '../../../../apps/api/src/modules/payout/domain/channel-result.ts';
import { BankCardChannel } from '../../../../apps/api/src/modules/payout/infra/channels/bank-card-channel.ts';
import { FakeChannel } from '../../../../apps/api/src/modules/payout/infra/channels/fake-channel.ts';
import { WechatChannel } from '../../../../apps/api/src/modules/payout/infra/channels/wechat-channel.ts';
import type { PayoutChannel } from '../../../../apps/api/src/modules/payout/infra/channels/payout-channel.ts';
import { EMPTY_LISTS, REQUEST, VERIFIED_TEST_LISTS } from './fixtures.ts';

it('[AC-B2-06b#33] fake channel consumes per-order/per-operation scripts, records calls, and never fetches', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
  try {
    const fake = new FakeChannel({
      mode: 'dry_run',
      lists: EMPTY_LISTS,
      script: {
        [REQUEST.outBizNo]: {
          transfer: [
            { kind: 'unknown' },
            {
              kind: 'response',
              raw: { code: '10000' },
              status: 'SUCCESS',
              channelOrderId: 'fake_order',
              paidAt: '2026-10-23T12:00:00+08:00',
            },
          ],
          query: [{ kind: 'response', raw: { code: '10000' }, status: 'SUCCESS' }],
        },
        another_order: {
          transfer: [{ kind: 'response', raw: { code: '10000' }, status: 'SUCCESS' }],
        },
      },
    });
    const channel: PayoutChannel = fake;
    expect((await channel.transfer(REQUEST)).kind).toBe('unknown');
    expect((await channel.transfer({ ...REQUEST, outBizNo: 'another_order' })).kind).toBe(
      'success',
    );
    expect((await channel.query(REQUEST.outBizNo)).kind).toBe('success');
    expect(await channel.transfer(REQUEST)).toMatchObject({
      kind: 'success',
      channelOrderId: 'fake_order',
      paidAt: '2026-10-23T12:00:00+08:00',
    });
    // Exhaustion must not repeat the last scripted success.
    expect((await channel.transfer(REQUEST)).kind).toBe('unknown');
    expect(fake.calls).toStrictEqual([
      { kind: 'transfer', request: REQUEST },
      { kind: 'transfer', request: { ...REQUEST, outBizNo: 'another_order' } },
      { kind: 'query', outBizNo: REQUEST.outBizNo },
      { kind: 'transfer', request: REQUEST },
      { kind: 'transfer', request: REQUEST },
    ]);
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});

it('[AC-B2-06b#34] fake defaults to unknown for missing orders and depleted query scripts', async () => {
  const fake = new FakeChannel({ mode: 'dry_run', lists: EMPTY_LISTS, script: {} });
  expect((await fake.transfer(REQUEST)).kind).toBe('unknown');
  expect((await fake.query(REQUEST.outBizNo)).kind).toBe('unknown');
  expect(fake.calls).toHaveLength(2);
});

it.each([
  ['TEST_CONFIRMED_FAIL', 'fail'],
  ['TEST_PAYER_SIDE', 'payer_side'],
  ['OUTSIDE_LIST', 'unknown'],
] as const)(
  '[AC-B2-06b#35] fake specified subCode %s uses the same configured judgement -> %s',
  async (subCode, kind) => {
    const fake = new FakeChannel({
      mode: 'dry_run',
      lists: VERIFIED_TEST_LISTS,
      script: {
        [REQUEST.outBizNo]: { transfer: [{ kind: 'response', raw: { code: '40004', subCode } }] },
      },
    });
    expect(await fake.transfer(REQUEST)).toMatchObject({ kind, raw: { code: '40004', subCode } });
    expect(fake.calls).toHaveLength(1);
  },
);

it('[AC-B2-06b#36] fake timeout step throws a timeout, consumes one step, and records the attempt', async () => {
  const fake = new FakeChannel({
    mode: 'dry_run',
    lists: EMPTY_LISTS,
    script: {
      [REQUEST.outBizNo]: {
        transfer: [
          { kind: 'timeout' },
          { kind: 'response', raw: { code: '10000' }, status: 'SUCCESS' },
        ],
      },
    },
  });
  await expect(fake.transfer(REQUEST)).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(fake.calls).toHaveLength(1);
  expect((await fake.transfer(REQUEST)).kind).toBe('success');
  expect(fake.calls).toHaveLength(2);
});

it('[AC-B2-06b#37] FakeChannel cannot be selected with live mode', () => {
  expect(() => new FakeChannel({ mode: 'live', lists: EMPTY_LISTS, script: {} })).toThrow(
    PayoutModeMustBeDryRunError,
  );
});

it.each([
  ['bank_card', BankCardChannel],
  ['wechat', WechatChannel],
] as const)(
  '[AC-B2-06b#38] closed %s transfer and query reject with normalized disabled evidence',
  async (name, Adapter) => {
    const channel: PayoutChannel = new Adapter();
    // Promise.resolve catches synchronous rejection too, but does not accept NotImplemented.
    for (const call of [
      () => channel.transfer({ ...REQUEST, channel: name }),
      () => channel.query(REQUEST.outBizNo),
    ]) {
      const promise = Promise.resolve().then<unknown>(call);
      await expect(promise).rejects.toBeInstanceOf(ChannelDisabledError);
      await expect(promise).rejects.toMatchObject({
        result: { kind: 'unknown', raw: { code: 'CHANNEL_DISABLED' } },
      });
    }
  },
);
