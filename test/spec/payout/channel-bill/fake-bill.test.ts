// B2-07b (规划/08 BR-WDR-23, BR-WDR-22 ⑧): FakeChannel's injectable demo bill behind
// PayoutChannel.billDetails(appId, billDate). Synthetic demo lines, NOT a captured Alipay bill.
import { expect, it, vi } from 'vitest';
import {
  PayoutBillUnavailableError,
  type ChannelBillLine,
} from '../../../../apps/api/src/modules/payout/domain/channel-result.ts';
import { FakeChannel } from '../../../../apps/api/src/modules/payout/infra/channels/fake-channel.ts';
import type { PayoutChannel } from '../../../../apps/api/src/modules/payout/infra/channels/payout-channel.ts';
import { EMPTY_LISTS, REQUEST } from '../channel/fixtures.ts';

const APP = 'app_demo_a';
const OTHER_APP = 'app_demo_b';
const DAY = '2026-10-28';
const NEXT_DAY = '2026-10-29';
const EMPTY_DAY = '2026-10-27';
const MISSING_DAY = '2026-10-26';

// An interface transfer (matched by out_biz_no) and a manual success without our number (matched
// by channel_order_id); amounts beyond 2^53 must survive as exact bigint fen.
const INTERFACE_LINE: ChannelBillLine = {
  outBizNo: 'W20261028000001',
  channelOrderId: 'demo_order_0001',
  amountFen: 10000n,
  status: 'SUCCESS',
  bookedAt: '2026-10-28T10:15:30+08:00',
};
const MANUAL_LINE: ChannelBillLine = {
  outBizNo: null,
  channelOrderId: 'demo_order_0002',
  amountFen: 9007199254740993n,
  status: 'SUCCESS',
  bookedAt: '2026-10-28T23:59:59+08:00',
};
const NEXT_DAY_LINE: ChannelBillLine = {
  outBizNo: 'W20261028000003',
  channelOrderId: 'demo_order_0003',
  amountFen: 1n,
  status: 'SUCCESS',
  bookedAt: '2026-10-29T00:00:01+08:00',
};
const OTHER_APP_LINE: ChannelBillLine = {
  outBizNo: 'W20261028000004',
  channelOrderId: 'demo_order_0004',
  amountFen: 500000n,
  status: 'SUCCESS',
  bookedAt: '2026-10-28T12:00:00+08:00',
};

function demoChannel(): FakeChannel {
  return new FakeChannel({
    mode: 'dry_run',
    lists: EMPTY_LISTS,
    script: {},
    bills: {
      [APP]: {
        [DAY]: [INTERFACE_LINE, MANUAL_LINE],
        [NEXT_DAY]: [NEXT_DAY_LINE],
        [EMPTY_DAY]: [],
      },
      [OTHER_APP]: { [DAY]: [OTHER_APP_LINE] },
    },
  });
}

it('[AC-B2-07b#1] the fake hands over the injected demo bill of the app and day as given, never fetching', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
  try {
    const fake = demoChannel();
    // billDetails is part of the PayoutChannel port with this very signature.
    const port: Required<Pick<PayoutChannel, 'billDetails'>> = fake;
    const lines = await port.billDetails(APP, DAY);
    expect(lines).toStrictEqual([INTERFACE_LINE, MANUAL_LINE]);
    expect(lines[1]?.amountFen).toBe(9007199254740993n);
    expect(lines[1]?.outBizNo).toBeNull();
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});

it('[AC-B2-07b#2] each bill belongs to one app and one accounting day only', async () => {
  const fake = demoChannel();
  expect(await fake.billDetails(OTHER_APP, DAY)).toStrictEqual([OTHER_APP_LINE]);
  expect(await fake.billDetails(APP, NEXT_DAY)).toStrictEqual([NEXT_DAY_LINE]);
  const own = await fake.billDetails(APP, DAY);
  expect(own.map((line) => line.channelOrderId)).toStrictEqual([
    'demo_order_0001',
    'demo_order_0002',
  ]);
});

it('[AC-B2-07b#3] a bill is read again unchanged (the next day re-reads it), unlike scripted steps', async () => {
  const fake = demoChannel();
  const first = await fake.billDetails(APP, DAY);
  const second = await fake.billDetails(APP, DAY);
  expect(second).toStrictEqual([INTERFACE_LINE, MANUAL_LINE]);
  expect(second).toStrictEqual(first);
});

it('[AC-B2-07b#4] a day without an injected bill rejects as unavailable; only an injected [] is an empty bill', async () => {
  const fake = demoChannel();
  expect(await fake.billDetails(APP, EMPTY_DAY)).toStrictEqual([]);
  for (const [appId, billDate] of [
    [APP, MISSING_DAY],
    ['app_unknown', DAY],
  ] as const) {
    const promise = Promise.resolve().then<unknown>(() => fake.billDetails(appId, billDate));
    await expect(promise).rejects.toBeInstanceOf(PayoutBillUnavailableError);
    await expect(promise).rejects.toMatchObject({
      name: 'PayoutBillUnavailableError',
      message: 'PAYOUT_BILL_UNAVAILABLE',
    });
  }
  // The dry_run runtime builds the fake without bills: it has no bill at all, never an empty one.
  const bare = new FakeChannel({ mode: 'dry_run', lists: EMPTY_LISTS, script: {} });
  await expect(
    Promise.resolve().then<unknown>(() => bare.billDetails(APP, DAY)),
  ).rejects.toBeInstanceOf(PayoutBillUnavailableError);
});

it('[AC-B2-07b#5] bill reads are recorded with the other calls, in order', async () => {
  const fake = demoChannel();
  await fake.transfer(REQUEST);
  await fake.billDetails(APP, DAY);
  await fake.query(REQUEST.outBizNo);
  await expect(
    Promise.resolve().then<unknown>(() => fake.billDetails(APP, MISSING_DAY)),
  ).rejects.toBeInstanceOf(PayoutBillUnavailableError);
  expect(fake.calls).toStrictEqual([
    { kind: 'transfer', request: REQUEST },
    { kind: 'bill', appId: APP, billDate: DAY },
    { kind: 'query', outBizNo: REQUEST.outBizNo },
    { kind: 'bill', appId: APP, billDate: MISSING_DAY },
  ]);
});
