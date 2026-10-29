// B2-07b (规划/08 BR-WDR-22 ⑧, BR-WDR-23): no adapter makes up a bill. Alipay's daily bill download
// is neither run in the sandbox nor recorded (规划/09 CAP-X-06), so AlipayChannel only keeps the
// port and rejects as unavailable without a gateway call; closed channels reject as disabled.
import { expect, it, vi } from 'vitest';
import {
  ChannelDisabledError,
  PayoutBillUnavailableError,
} from '../../../../apps/api/src/modules/payout/domain/channel-result.ts';
import { AlipayChannel } from '../../../../apps/api/src/modules/payout/infra/channels/alipay-channel.ts';
import { BankCardChannel } from '../../../../apps/api/src/modules/payout/infra/channels/bank-card-channel.ts';
import type { PayoutChannel } from '../../../../apps/api/src/modules/payout/infra/channels/payout-channel.ts';
import { WechatChannel } from '../../../../apps/api/src/modules/payout/infra/channels/wechat-channel.ts';
import { fixture } from '../channel/fixtures.ts';

const APP = 'app_demo_a';

it.each(['2026-10-28', '2026-10-01', '2026-12-31'])(
  '[AC-B2-07b#6] AlipayChannel bill of %s rejects as unavailable and never calls the gateway',
  async (billDate) => {
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected network'));
    try {
      const { options, send } = fixture();
      const channel = new AlipayChannel(options);
      const port: Required<Pick<PayoutChannel, 'billDetails'>> = channel;
      const promise = Promise.resolve().then<unknown>(() => port.billDetails(APP, billDate));
      await expect(promise).rejects.toBeInstanceOf(PayoutBillUnavailableError);
      await expect(promise).rejects.toMatchObject({ message: 'PAYOUT_BILL_UNAVAILABLE' });
      expect(send).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  },
);

it.each([
  ['bank_card', BankCardChannel],
  ['wechat', WechatChannel],
] as const)(
  '[AC-B2-07b#7] closed %s bill rejects with the normalized disabled evidence',
  async (_name, Adapter) => {
    const port: Required<Pick<PayoutChannel, 'billDetails'>> = new Adapter();
    const promise = Promise.resolve().then<unknown>(() => port.billDetails(APP, '2026-10-28'));
    await expect(promise).rejects.toBeInstanceOf(ChannelDisabledError);
    await expect(promise).rejects.toMatchObject({
      result: { kind: 'unknown', raw: { code: 'CHANNEL_DISABLED' } },
    });
  },
);
