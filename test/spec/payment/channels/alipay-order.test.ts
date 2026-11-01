// B2-15k 支付宝下单（claude-independent，SPEC_REF deb521c2）：08 BR-PAY-03（签名只在服务端，支付截止时间不晚于
// expire_at）；任务书 9.6：本地签 orderStr（RSA2），不联网；分→元只经 formatFen。
// 出处：docs-mirror/alipay/app-pay/02e7gq.md（公共参数 6-18、业务参数 22）、01dcc0.md:105（orderStr 只是加签数据）。
// 未实测（BR-PAY-09）。
import { expect, it } from 'vitest';
import type { AlipayLaunch } from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import { NOTIFY_ROUTES } from '../../../../apps/api/src/modules/payment/application/notify-routes.ts';
import {
  ALIPAY_APPID,
  ALIPAY_ORDER,
  NOTIFY_BASE,
  OUT,
  alipayChannel,
  expectAliSigned,
  expectUnknown,
  okOf,
  textOf,
  type Json,
} from './kit.ts';

function orderParams(launch: unknown): Map<string, string> {
  return new Map(new URLSearchParams((launch as AlipayLaunch).order_str));
}

it('[AC-B2-15k#601] createOrder 本地签 orderStr，不发任何请求；公共参数齐全，时间戳取注入时钟（+08:00）', async () => {
  const h = alipayChannel();
  const result = okOf(await h.channel.createOrder(ALIPAY_ORDER));
  expect(h.calls).toHaveLength(0);
  expect(result.channelRef).not.toBe('');
  const params = orderParams(result.launch);
  expect(params.get('app_id')).toBe(ALIPAY_APPID);
  expect(params.get('method')).toBe('alipay.trade.app.pay');
  expect(params.get('charset')).toBe('utf-8');
  expect(params.get('version')).toBe('1.0');
  expect(params.get('timestamp')).toBe('2026-11-01 12:00:00');
  expect(params.get('notify_url')).toBe(`${NOTIFY_BASE}${NOTIFY_ROUTES.alipay}`);
  expectAliSigned(params);
});

it('[AC-B2-15k#602] biz_content：out_trade_no、total_amount、subject、product_code、time_expire；中文标题按 UTF-8 签名', async () => {
  const h = alipayChannel();
  const params = orderParams(okOf(await h.channel.createOrder(ALIPAY_ORDER)).launch);
  const biz = JSON.parse(params.get('biz_content') ?? '{}') as Json;
  expect(biz).toEqual({
    out_trade_no: OUT,
    total_amount: '1.00',
    subject: ALIPAY_ORDER.description,
    product_code: 'QUICK_MSECURITY_PAY',
    time_expire: '2026-11-01 12:15:00',
  });
  expectAliSigned(params);
});

it('[AC-B2-15k#603] time_expire 是 +08:00 的 yyyy-MM-dd HH:mm:ss，舍去毫秒，不晚于 expireAt', async () => {
  const h = alipayChannel();
  const input = { ...ALIPAY_ORDER, expireAt: new Date('2026-11-01T15:59:59.999Z') };
  const params = orderParams(okOf(await h.channel.createOrder(input)).launch);
  const biz = JSON.parse(params.get('biz_content') ?? '{}') as { time_expire: string };
  expect(biz.time_expire).toBe('2026-11-01 23:59:59');
});

it.each([
  [1n, '0.01'],
  [99n, '0.99'],
  [100n, '1.00'],
  [101n, '1.01'],
  [2147483648n, '21474836.48'],
  [2147483649n, '21474836.49'],
])('[AC-B2-15k#604] 金额边界 %s 分 → total_amount %s（不经浮点）', async (fen, yuan) => {
  const h = alipayChannel();
  const params = orderParams(
    okOf(await h.channel.createOrder({ ...ALIPAY_ORDER, amountFen: fen })).launch,
  );
  const biz = JSON.parse(params.get('biz_content') ?? '{}') as { total_amount: string };
  expect(biz.total_amount).toBe(yuan);
});

it.each([
  ['0 分（文档：金额不能为 0）', 0n],
  ['负数', -1n],
])('[AC-B2-15k#605] 非法下单金额（%s）：unknown，不抛异常', async (_name, fen) => {
  const h = alipayChannel();
  expectUnknown(await h.channel.createOrder({ ...ALIPAY_ORDER, amountFen: fen }));
});

it('[AC-B2-15k#606] 应用私钥不进调起参数（BR-PAY-03：不得由服务端下发）', async () => {
  const h = alipayChannel();
  const result = okOf(await h.channel.createOrder(ALIPAY_ORDER));
  expect(textOf(result)).not.toContain('PRIVATE KEY');
  expect(new Set(Object.keys(result.launch))).toEqual(new Set(['order_str']));
});

it('[AC-B2-15k#607] 含加号和空格的标题经 URL 编码后还原不变，签名仍过', async () => {
  const h = alipayChannel();
  const description = 'a+b c';
  const params = orderParams(
    okOf(await h.channel.createOrder({ ...ALIPAY_ORDER, description })).launch,
  );
  const biz = JSON.parse(params.get('biz_content') ?? '{}') as { subject: string };
  expect(biz.subject).toBe(description);
  expectAliSigned(params);
});
