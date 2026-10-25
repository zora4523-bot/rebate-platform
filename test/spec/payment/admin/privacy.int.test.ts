// B2-15f privacy rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-08 ④ (调起参数、通知原文
// 里的个人信息不进日志；支付单接口不返回渠道侧的用户标识); payment/AGENTS.md rule 6; contracts/openapi.yaml
// AdminPayOrder / AdminPayAnomaly / AdminPayQueryAttempt / AdminPayChannelResult (no channel-side
// user identifier; additionalProperties false).
// The pay orders and the anomaly are settled by real notifications through the api entry
// (../result/kit.ts withNotify): the WeChat resource carries payer.openid, the Alipay form buyer_id
// and buyer_logon_id; then the admin entry (kit.ts withAdmin) reads them. Top-level it() only.
import { expect, it } from 'vitest';
import { fixture, payOrder, seedOrder, suite } from '../orders/kit.ts';
import { acked, anomalies, paidNotification, seedPending, withNotify } from '../result/kit.ts';
import {
  AMOUNT,
  ANOMALY_KEYS,
  ATTEMPT_KEYS,
  CHANNELS,
  ORDER_KEYS,
  RESULT_KEYS,
  adminChannels,
  keysOf,
  ok,
  page,
  seedNeedsManual,
  withAdmin,
} from './kit.ts';

const s = suite();

it.each(CHANNELS)(
  '[AC-B2-15f#22] %s BR-PAY-08 ④ 经真实支付通知结束的支付单与异常收款（通知原文带付款人标识 openid / buyer_id / buyer_logon_id）：支付单列表、详情、异常收款列表、处置应答逐项只有契约字段，响应全文不含通知原文里的付款人标识与签名',
  async (channel) => {
    const f = await fixture(s);
    const channels = adminChannels(f);
    const identity = channels[channel].identity;
    const paid = await seedPending(f, channel);
    const closed = await seedOrder(f, {
      pay_channel: channel,
      amount_fen: AMOUNT,
      status: 'CLOSED',
      close_reason: 'expired',
      launch_issued_at: f.clock.now(),
      closed_at: f.clock.now(),
    });
    const onTime = paidNotification(channels, identity, paid);
    const late = paidNotification(channels, identity, closed);
    await withNotify(f, channels, async (n) => {
      acked(channel, await n.deliver(channel, onTime.raw));
      acked(channel, await n.deliver(channel, late.raw));
    });
    expect(await payOrder(f, paid.id)).toMatchObject({ status: 'PAID' });
    expect(await anomalies(f)).toHaveLength(1);
    const manual = await seedNeedsManual(f, channel);
    channels[channel].script(manual, 'paid');
    const secrets = [...onTime.secrets, ...late.secrets];
    await withAdmin(f, channels, async (h) => {
      const listed = await h.list();
      for (const item of (await page(listed)).items) expect(keysOf(item)).toEqual([...ORDER_KEYS]);
      const shown = await h.detail(paid.id);
      const detail = await ok(shown);
      expect(keysOf(detail['pay_order'])).toEqual([...ORDER_KEYS]);
      for (const attempt of detail['query_attempts'] as unknown[]) {
        expect(keysOf(attempt)).toEqual([...ATTEMPT_KEYS]);
      }
      const received = await h.anomalies();
      const anomalyPage = await page(received);
      expect(anomalyPage.items).toHaveLength(1);
      for (const item of anomalyPage.items) expect(keysOf(item)).toEqual([...ANOMALY_KEYS]);
      const resolved = await h.resolve(manual.id);
      const settled = await ok(resolved);
      expect(keysOf(settled['pay_order'])).toEqual([...ORDER_KEYS]);
      expect(keysOf(settled['channel_result'])).toEqual([...RESULT_KEYS]);
      for (const sent of [listed, shown, received, resolved]) {
        for (const secret of secrets) expect(sent.body, sent.op).not.toContain(secret);
      }
    });
  },
);
