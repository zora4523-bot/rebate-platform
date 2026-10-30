// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ATTEMPT_TIME,
  BIZ,
  CHANNEL_TRADE_NO,
  CHANNEL_USER,
  ORDER,
  OUT_REFUND_NO,
  OUT_TRADE_NO,
  USER,
  createServer,
  detailRoute,
  orderPath,
} from './fixtures.ts';
import {
  AMOUNT_LABEL,
  FLOW_TIMEOUT,
  NOT_A_VALUE,
  NOT_FOUND,
  SECTION,
  idToken,
  labelledTexts,
  mount,
  rowsContaining,
  rowsWith,
  settled,
  showsName,
  showsYuan,
  squash,
  textOf,
  token,
} from './helpers.ts';

/** Opens the detail address of the partly refunded sample and waits for its refund rows. */
async function openRefunded() {
  const server = createServer();
  await mount(server, { route: detailRoute(ORDER.refunded) });
  await waitFor(() => expect(server.detailReads(ORDER.refunded).length).toBeGreaterThan(0));
  await settled(server);
  await waitFor(() =>
    expect(rowsWith(document.body, [token(OUT_REFUND_NO.success)])).toHaveLength(1),
  );
  return server;
}
function refundRow(number: string): HTMLElement {
  const found = rowsWith(document.body, [token(number)]);
  expect(found, `one refund row ${number}`).toHaveLength(1);
  return found[0]!;
}

it(
  '[AC-F1-13a-DETAIL#1] 详情地址 pay-orders/{id}：只读该支付单，显示基本信息（商户单号、渠道交易号、渠道与状态字典名、业务、用户、创建与支付时间）',
  async () => {
    const server = await openRefunded();
    const page = textOf(document.body);
    const flat = squash(page);
    expect(page).toMatch(token(OUT_TRADE_NO.refunded));
    expect(page).toMatch(token(CHANNEL_TRADE_NO.refunded));
    expect(showsName(page, 'channel', 'alipay'), 'channel name').toBe(true);
    expect(showsName(page, 'payStatus', 'PAID'), 'status name').toBe(true);
    expect(showsName(page, 'bizType', BIZ.membership), 'business type').toBe(true);
    expect(page).toMatch(idToken(USER.refunded));
    expect(flat, 'created_at (Beijing)').toContain('2026-10-1909:00');
    expect(flat, 'paid_at (Beijing)').toContain('2026-10-1909:01');
    expect(server.requests('GET', orderPath(ORDER.refunded)).length).toBeGreaterThan(0);
    for (const id of [ORDER.manual, ORDER.closed, ORDER.paid])
      expect(server.detailReads(id), `no detail read of ${id.slice(0, 8)}`).toEqual([]);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-DETAIL#2] 金额各在其标签项内：金额 128.00 与已退 30.50（按分手算），两者不对调',
  async () => {
    await openRefunded();
    // amount_fen 12800 → 128.00; refunded_fen 3050 → 30.50.
    const amounts = labelledTexts(document.body, AMOUNT_LABEL.amount);
    expect(amounts.length, 'an item labelled 金额').toBeGreaterThan(0);
    expect(
      amounts.some((text) => showsYuan(text, '128.00') && !showsYuan(text, '30.50')),
      `金额 shows 128.00 (items: ${amounts.join(' | ')})`,
    ).toBe(true);
    const refunded = labelledTexts(document.body, AMOUNT_LABEL.refunded);
    expect(refunded.length, 'an item labelled 已退').toBeGreaterThan(0);
    expect(
      refunded.some((text) => showsYuan(text, '30.50') && !showsYuan(text, '128.00')),
      `已退 shows 30.50 (items: ${refunded.join(' | ')})`,
    ).toBe(true);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-DETAIL#3] 退款记录：两张退款单各一行，显示退款单号、金额（按分手算）、状态与原因码的字典名',
  async () => {
    await openRefunded();
    expect(squash(document.body.textContent)).toMatch(SECTION.refunds);
    const success = refundRow(OUT_REFUND_NO.success);
    const failed = refundRow(OUT_REFUND_NO.failed);
    // 3050 fen → 30.50; 2000 fen → 20.00.
    expect(showsYuan(textOf(success), '30.50')).toBe(true);
    expect(showsYuan(textOf(success), '20.00')).toBe(false);
    expect(showsYuan(textOf(failed), '20.00')).toBe(true);
    expect(showsYuan(textOf(failed), '30.50')).toBe(false);
    expect(showsName(textOf(success), 'refundStatus', 'SUCCESS'), 'SUCCESS').toBe(true);
    expect(showsName(textOf(success), 'refundReason', 'USER_REQUEST'), 'USER_REQUEST').toBe(true);
    expect(showsName(textOf(failed), 'refundStatus', 'FAILED'), 'FAILED').toBe(true);
    expect(showsName(textOf(failed), 'refundReason', 'DUPLICATE_PAYMENT'), 'reason').toBe(true);
    for (const row of [success, failed]) expect(textOf(row)).not.toMatch(NOT_A_VALUE);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-DETAIL#4] 近期渠道请求摘要：三条各一行，显示类型、结果与时间（类型与结果缺字典键时显示编码）',
  async () => {
    await openRefunded();
    expect(squash(document.body.textContent)).toMatch(SECTION.attempts);
    const cases = [
      [ATTEMPT_TIME.refundQuery, 'refund_query', 'ok'],
      [ATTEMPT_TIME.refund, 'refund', 'unknown'],
      [ATTEMPT_TIME.query, 'query', 'ok'],
    ] as const;
    for (const [time, kind, result] of cases) {
      const rows = rowsContaining(time);
      expect(rows, `one request row at ${time}`).toHaveLength(1);
      const text = textOf(rows[0]!);
      expect(showsName(text, 'attemptKind', kind), `${time} kind ${kind}`).toBe(true);
      expect(showsName(text, 'attemptResult', result), `${time} result ${result}`).toBe(true);
    }
    // The refund request is not shown as a refund query, nor the other way round.
    expect(
      showsName(textOf(rowsContaining(ATTEMPT_TIME.refund)[0]!), 'attemptKind', 'refund_query'),
    ).toBe(false);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-DETAIL#5] 详情页面上不出现渠道侧用户标识（契约不返回；假服务端夹带的对照值也不显示）',
  async () => {
    await openRefunded();
    const page = document.body.textContent ?? '';
    for (const value of Object.values(CHANNEL_USER))
      expect(page, `channel-side user ${value}`).not.toContain(value);
    expect(
      Array.from(document.querySelectorAll('[title], [value], [href]')).some((node) =>
        Object.values(CHANNEL_USER).some((value) =>
          ['title', 'value', 'href'].some((name) =>
            (node.getAttribute(name) ?? '').includes(value),
          ),
        ),
      ),
      'not in attributes either',
    ).toBe(false);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-DETAIL#6] 不存在或他 app 的支付单（详情返回 20001 [pay_order_id]）：显示未找到类提示，不显示别的支付单',
  async () => {
    const unknown = 'a9999999-0000-4000-8000-000000000999';
    const server = createServer();
    await mount(server, { route: detailRoute(unknown) });
    await waitFor(() => expect(server.detailReads(unknown).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(squash(document.body.textContent)).toMatch(NOT_FOUND));
    for (const number of Object.values(OUT_TRADE_NO))
      expect(document.body.textContent, number).not.toContain(number);
    expect(rowsWith(document.body, [token(OUT_REFUND_NO.success)])).toEqual([]);
  },
  FLOW_TIMEOUT,
);
