import { expect, it } from 'vitest';
import {
  converted,
  ctx,
  dataWithout,
  envelope,
  identity,
  instant,
  PRIVILEGE_PATH,
  privilegeData,
  req,
  response,
  setup,
  SHORT_URL,
  visible,
} from './kit.ts';

// BR-PRICE-11：quoted_at 等于服务端收到该价格所依据的联盟接口响应的时刻（注入 Clock）。
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|\+08:00)$/;
/** The transport moves the injected clock this far while the request is "on the wire". */
const WIRE_MS = 1_500;

it('[AC-B1-04d#16] requote：originalPrice / actualPrice 元转分，券信息原样，quoted_at = 收到大淘客响应时的注入时钟', async () => {
  const h = setup({ onSend: (clock) => clock.advanceMs(WIRE_MS) });
  const result = await converted(() => h.adapter.convert(req, identity, ctx));
  expect(result.requote).toBeDefined();
  const requote = result.requote!;
  expect(requote.price_fen).toBe(4990n);
  expect(requote.final_price_fen).toBe(3990n);
  expect(requote.coupon_info).toBe('synthetic coupon: 10 off 50');
  expect(requote.coupon_start_time).toBe('2026-11-01 00:00:00');
  expect(requote.coupon_end_time).toBe('2026-11-11 23:59:59');
  expect(requote.coupon_total_count).toBe(100);
  expect(requote.coupon_remain_count).toBe(70);
  expect(requote.quoted_at).toMatch(ISO_INSTANT);
  expect(Date.parse(requote.quoted_at)).toBe(Date.parse(instant) + WIRE_MS);
  // 返利比例不在本任务计算。
  for (const key of Object.keys(requote)) expect(key).not.toMatch(/commission|rebate|rate/i);
});

it.each([
  ['12', 1200n],
  ['12.3', 1230n],
  ['0.05', 5n],
  // yuanStrToFen 截到分（向下），不四舍五入。
  ['19.999', 1999n],
  ['7.005', 700n],
])('[AC-B1-04d#17] 金额 %s 元按 yuanStrToFen 得 %s 分', async (yuan, fen) => {
  const h = setup({
    reply: response(envelope(privilegeData({ originalPrice: yuan, actualPrice: yuan }))),
  });
  const result = await converted(() => h.adapter.convert(req, identity, ctx));
  expect(result.requote?.price_fen).toBe(fen);
  expect(result.requote?.final_price_fen).toBe(fen);
  expect(h.warn).not.toHaveBeenCalled();
});

it('[AC-B1-04d#18] 券字段缺失时 requote 不补券字段，价格照给', async () => {
  const data = dataWithout(
    'couponInfo',
    'couponStartTime',
    'couponEndTime',
    'couponTotalCount',
    'couponRemainCount',
  );
  const h = setup({ reply: response(envelope(data)) });
  const result = await converted(() => h.adapter.convert(req, identity, ctx));
  expect(result.requote).toBeDefined();
  expect(result.requote!.price_fen).toBe(4990n);
  expect(result.requote!.final_price_fen).toBe(3990n);
  for (const key of [
    'coupon_info',
    'coupon_start_time',
    'coupon_end_time',
    'coupon_total_count',
    'coupon_remain_count',
  ]) {
    expect(result.requote).not.toHaveProperty(key);
  }
});

const INVALID_AMOUNTS = ['abc-synthetic', '1e3', '12.3.4', ' 12', '0x10', 'NaN'];
const INVALID_CASES = INVALID_AMOUNTS.flatMap((bad): [string, string][] => [
  ['originalPrice', bad],
  ['actualPrice', bad],
]);

it.each(INVALID_CASES)(
  '[AC-B1-04d#19] %s 非法（%s）→ 省略 requote 并告警一次（不带原值），转链结果不受影响',
  async (field, bad) => {
    const h = setup({ reply: response(envelope(privilegeData({ [field]: bad }))) });
    const result = await converted(() => h.adapter.convert(req, identity, ctx));
    expect(result.url).toBe(SHORT_URL);
    expect(result).not.toHaveProperty('requote');
    expect(h.warn).toHaveBeenCalledTimes(1);
    const event = h.warn.mock.calls[0]![0];
    expect(event.method).toBe(PRIVILEGE_PATH);
    expect(event.code).toBeTypeOf('string');
    expect(visible(event)).not.toContain(bad);
  },
);

it.each([
  ['originalPrice absent', dataWithout('originalPrice')],
  ['actualPrice absent', dataWithout('actualPrice')],
  ['originalPrice null', privilegeData({ originalPrice: null })],
  ['actualPrice an object', privilegeData({ actualPrice: { value: '39.90' } })],
])('[AC-B1-04d#20] %s → 省略 requote，转链结果不受影响', async (_label, data) => {
  const h = setup({ reply: response(envelope(data)) });
  const result = await converted(() => h.adapter.convert(req, identity, ctx));
  expect(result.url).toBe(SHORT_URL);
  expect(result.tpwd).toBeTypeOf('string');
  expect(result).not.toHaveProperty('requote');
});
