// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ALL_GRANTS,
  ORDER,
  OUT_TRADE_NO,
  REFUNDABLE,
  REFUND_ONLY_GRANTS,
  RESOLVE_ONLY_GRANTS,
  SUPER,
  VIEW_GRANTS,
  VIEW_REFUND_GRANTS,
  VIEW_RESOLVE_GRANTS,
  createServer,
  detailRoute,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  FORBIDDEN,
  WRITE_ENTRY,
  assertNoStepUp,
  main,
  mount,
  openDetail,
  pressWrites,
  refundEntries,
  refundableShown,
  resolveEntries,
  settle,
  settled,
  usable,
} from './helpers.ts';

it(
  '[AC-F1-13b-ENTRY#1] 超管进部分退款的已支付单详情：详情照常加载并有可用的【发起退款】、没有可用的【立即查询】；进待人工处置单（PENDING、needs_manual）详情：有可用的【立即查询】、没有可用的【发起退款】；不点不发 POST，不读退款单列表',
  async () => {
    const paid = createServer(undefined, { permissions: ALL_GRANTS });
    await openDetail(paid, ORDER.refunded, OUT_TRADE_NO.refunded, SUPER);
    await waitFor(() =>
      expect(refundEntries().length, '【发起退款】 for super').toBeGreaterThan(0),
    );
    expect(resolveEntries(), 'no 【立即查询】 on a PAID pay order').toEqual([]);
    for (const shown of refundableShown(main())) expect(shown).toBe(REFUNDABLE.refunded.yuan);
    await settled(paid);
    expect(paid.writes()).toEqual([]);
    expect(paid.refundReads()).toEqual([]);
    cleanup();

    const manual = createServer(undefined, { permissions: ALL_GRANTS });
    await openDetail(manual, ORDER.manual, OUT_TRADE_NO.manual, SUPER);
    await waitFor(() =>
      expect(resolveEntries().length, '【立即查询】 for super').toBeGreaterThan(0),
    );
    expect(refundEntries(), 'no 【发起退款】 on a PENDING pay order').toEqual([]);
    await settled(manual);
    expect(manual.writes()).toEqual([]);
    expect(manual.refundReads()).toEqual([]);
    assertNoStepUp(manual);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-ENTRY#2] 持 pay.view + pay.refund：部分退款的已支付单详情有可用的【发起退款】；待人工处置单详情既没有【发起退款】也没有【立即查询】（缺 pay.resolve）',
  async () => {
    const paid = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
    await openDetail(paid, ORDER.refunded, OUT_TRADE_NO.refunded);
    await waitFor(() => expect(refundEntries().length).toBeGreaterThan(0));
    expect(resolveEntries()).toEqual([]);
    cleanup();

    const manual = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
    await openDetail(manual, ORDER.manual, OUT_TRADE_NO.manual);
    expect(usable(main(), WRITE_ENTRY), 'no usable write entry').toEqual([]);
    await pressWrites(main());
    await settled(manual);
    expect(manual.writes()).toEqual([]);
    expect(manual.refundReads()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-ENTRY#3] 持 pay.view + pay.resolve：待人工处置单详情有可用的【立即查询】；部分退款的已支付单详情既没有【立即查询】也没有【发起退款】（缺 pay.refund）',
  async () => {
    const manual = createServer(undefined, { permissions: VIEW_RESOLVE_GRANTS });
    await openDetail(manual, ORDER.manual, OUT_TRADE_NO.manual);
    await waitFor(() => expect(resolveEntries().length).toBeGreaterThan(0));
    expect(refundEntries()).toEqual([]);
    await settled(manual);
    expect(manual.writes()).toEqual([]);
    cleanup();

    const paid = createServer(undefined, { permissions: VIEW_RESOLVE_GRANTS });
    await openDetail(paid, ORDER.refunded, OUT_TRADE_NO.refunded);
    expect(usable(main(), WRITE_ENTRY), 'no usable write entry').toEqual([]);
    await pressWrites(main());
    await settled(paid);
    expect(paid.writes()).toEqual([]);
    assertNoStepUp(paid);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-ENTRY#4] 只持 pay.view：已支付单与待人工处置单详情都没有可用的【发起退款】【立即查询】，按了也不发 POST、不弹动态码；同一张已支付单换成持 pay.view + pay.refund 的账号则出现【发起退款】',
  async () => {
    for (const [id, outTradeNo] of [
      [ORDER.refunded, OUT_TRADE_NO.refunded],
      [ORDER.manual, OUT_TRADE_NO.manual],
    ] as const) {
      const server = createServer(undefined, { permissions: VIEW_GRANTS });
      await openDetail(server, id, outTradeNo);
      expect(usable(main(), WRITE_ENTRY), `${outTradeNo} no usable write entry`).toEqual([]);
      await pressWrites(main());
      await settled(server);
      expect(server.writes(), `${outTradeNo} no write`).toEqual([]);
      expect(server.refundReads()).toEqual([]);
      assertNoStepUp(server);
      cleanup();
    }

    const allowed = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
    await openDetail(allowed, ORDER.refunded, OUT_TRADE_NO.refunded);
    await waitFor(() => expect(refundEntries().length).toBeGreaterThan(0));
  },
  FLOW_TIMEOUT,
);

it.each([
  {
    point: 'pay.refund',
    grants: REFUND_ONLY_GRANTS,
    withView: VIEW_REFUND_GRANTS,
    id: ORDER.refunded,
    outTradeNo: OUT_TRADE_NO.refunded,
  },
  {
    point: 'pay.resolve',
    grants: RESOLVE_ONLY_GRANTS,
    withView: VIEW_RESOLVE_GRANTS,
    id: ORDER.manual,
    outTradeNo: OUT_TRADE_NO.manual,
  },
] as const)(
  '[AC-F1-13b-ENTRY#5] 只持 $point 而无 pay.view：直达详情地址显示无权限提示，不发任何支付单请求、没有写入口；加上 pay.view 后同一单出现对应入口',
  async ({ point, grants, withView, id, outTradeNo }) => {
    const server = createServer(undefined, { permissions: grants });
    await mount(server, { route: detailRoute(id) });
    await settle();
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(FORBIDDEN));
    await settled(server);
    expect(server.payRequests()).toEqual([]);
    expect(usable(main(), WRITE_ENTRY)).toEqual([]);
    cleanup();

    const viewer = createServer(undefined, { permissions: withView });
    await openDetail(viewer, id, outTradeNo);
    const entries = point === 'pay.refund' ? refundEntries : resolveEntries;
    await waitFor(() => expect(entries().length, `the entry of ${point}`).toBeGreaterThan(0));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-ENTRY#6] 三个权限都有：已关闭的单、未进人工处置的待支付单详情都没有可用的【发起退款】【立即查询】，按了也不发 POST；未退款的已支付单有【发起退款】',
  async () => {
    for (const [id, outTradeNo] of [
      [ORDER.closed, OUT_TRADE_NO.closed],
      [ORDER.pending, OUT_TRADE_NO.pending],
    ] as const) {
      const server = createServer(undefined, { permissions: ALL_GRANTS });
      await openDetail(server, id, outTradeNo);
      expect(usable(main(), WRITE_ENTRY), `${outTradeNo} no usable write entry`).toEqual([]);
      await pressWrites(main());
      await settled(server);
      expect(server.writes(), `${outTradeNo} no write`).toEqual([]);
      assertNoStepUp(server);
      cleanup();
    }

    const paid = createServer(undefined, { permissions: ALL_GRANTS });
    await openDetail(paid, ORDER.paid, OUT_TRADE_NO.paid);
    await waitFor(() => expect(refundEntries().length).toBeGreaterThan(0));
    expect(resolveEntries()).toEqual([]);
    for (const shown of refundableShown(main())) expect(shown).toBe(REFUNDABLE.paid.yuan);
  },
  FLOW_TIMEOUT,
);
