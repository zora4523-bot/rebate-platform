// B2-15k 不可用通道（claude-independent，SPEC_REF deb521c2）：08 BR-PAY-08 ②；payment/AGENTS.md 第 6 条（缺失时
// fail-close：不下单、不处理通知）；任务书 9.9：调用都是 unknown / channel_unconfigured，通知 rejected，不抛异常。
import { expect, it } from 'vitest';
import { UnavailablePayChannel } from '../../../../apps/api/src/modules/payment/infra/channels/index.ts';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import {
  ALIPAY_ORDER,
  MCHID,
  ORDER,
  OUT,
  OUT_REFUND,
  REFUND,
  WX_APPID,
  expectRejected,
  wxPayNotification,
} from './kit.ts';

const UNCONFIGURED = { kind: 'unknown', reason: 'channel_unconfigured' };
const CHANNELS: readonly PayChannelCode[] = ['wechat_pay', 'alipay'];

it.each(CHANNELS)(
  '[AC-B2-15k#1301] %s：下单、查单、关单、退款、退款查询、账单都是 unknown / channel_unconfigured',
  async (code) => {
    const channel = new UnavailablePayChannel(code);
    expect(channel.channel).toBe(code);
    expect(await channel.createOrder(code === 'alipay' ? ALIPAY_ORDER : ORDER)).toEqual(
      UNCONFIGURED,
    );
    expect(await channel.query(OUT)).toEqual(UNCONFIGURED);
    expect(await channel.close(OUT)).toEqual(UNCONFIGURED);
    expect(await channel.refund(REFUND)).toEqual(UNCONFIGURED);
    expect(await channel.refundQuery(OUT_REFUND)).toEqual(UNCONFIGURED);
    expect(await channel.downloadBill('2026-10-31', 'couli-app-test')).toEqual(UNCONFIGURED);
  },
);

it.each(CHANNELS)(
  '[AC-B2-15k#1302] %s：通知一律 rejected（不处理），ownerAppOf 是 null',
  async (code) => {
    const channel = new UnavailablePayChannel(code);
    expectRejected(await channel.verifyNotification(wxPayNotification()));
    expect(channel.ownerAppOf({ merchantRef: MCHID, appRef: WX_APPID })).toBeNull();
  },
);
