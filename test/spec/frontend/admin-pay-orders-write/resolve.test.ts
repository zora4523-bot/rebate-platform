// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ORDER,
  OUT_TRADE_NO,
  VERIFY,
  VIEW_RESOLVE_GRANTS,
  createServer,
  issuedStepUp,
  namePattern,
  resolvePath,
  stepUpRequired,
  type Server,
} from './fixtures.ts';
import {
  CONFLICT,
  FLOW_TIMEOUT,
  SETTLED_CLOSED,
  SETTLED_PAID,
  UNCHANGED,
  assertResolve,
  assertVerified,
  click,
  freshText,
  main,
  openDetail,
  permitWrites,
  refundEntries,
  resolveEntries,
  settle,
  settled,
  snapshotText,
  startResolve,
  stepUpDialog,
  stepUpOpen,
  verify,
} from './helpers.ts';

/** The status shown in the detail's labelled status item matches `code`'s dictionary name. */
function showsStatus(code: string): boolean {
  return namePattern('payStatus', code).test(main().textContent ?? '');
}
/** A pay.view + pay.resolve server that may receive the verification and the manual resolve. */
function resolveServer(): Server {
  const server = createServer(undefined, { permissions: VIEW_RESOLVE_GRANTS });
  permitWrites(server, ['POST', VERIFY], ['POST', resolvePath(ORDER.manual)]);
  return server;
}
/** Only the four reads, the verification and the resolve of the manual sample went out. */
function onlyResolveSent(server: Server): void {
  expect(
    server.unexpected([
      ['POST', VERIFY],
      ['POST', resolvePath(ORDER.manual)],
    ]),
  ).toEqual([]);
  expect(server.refunds()).toEqual([]);
  expect(server.refundReads()).toEqual([]);
}

it(
  '[AC-F1-13b-RESOLVE#1] 待人工处置单【立即查询】：先弹动态码（此前不发 POST），验证后 POST …/resolve 带 X-Step-Up-Token、固定请求体 {expected_status: PENDING, action: query_and_settle}、无 Idempotency-Key；渠道已支付 → 提示已支付并重新读取详情，状态变「已支付」，入口消失',
  async () => {
    const server = resolveServer();
    server.setResolveOutcome('paid');
    await openDetail(server, ORDER.manual, OUT_TRADE_NO.manual);
    const modal = await startResolve();
    expect(server.resolves()).toEqual([]);
    expect(server.verifies()).toEqual([]);
    const reads = server.detailReads(ORDER.manual).length;
    const before = snapshotText();
    await verify(modal);
    await waitFor(() => expect(server.resolves(ORDER.manual)).toHaveLength(1));
    await settled(server);
    assertResolve(server.resolves(ORDER.manual)[0]!, issuedStepUp(1));
    assertVerified(server, 1);
    await waitFor(() => expect(freshText(before)).toMatch(SETTLED_PAID));
    expect(freshText(before)).not.toMatch(UNCHANGED);
    await waitFor(() =>
      expect(server.detailReads(ORDER.manual).length, 'the detail is read again').toBeGreaterThan(
        reads,
      ),
    );
    await settled(server);
    await waitFor(() => expect(showsStatus('PAID')).toBe(true));
    await waitFor(() => expect(resolveEntries()).toEqual([]));
    onlyResolveSent(server);
  },
  FLOW_TIMEOUT,
);

it.each([
  { outcome: 'closed', name: '渠道已关闭' },
  { outcome: 'not_exist_closed', name: '渠道无此单且已过宽限（服务端按 PO3 关闭）' },
] as const)(
  '[AC-F1-13b-RESOLVE#2] 【立即查询】$name：提示已关闭（不提示已支付），重新读取详情，状态变「已关闭」，入口消失',
  async ({ outcome }) => {
    const server = resolveServer();
    server.setResolveOutcome(outcome);
    await openDetail(server, ORDER.manual, OUT_TRADE_NO.manual);
    const modal = await startResolve();
    const reads = server.detailReads(ORDER.manual).length;
    const before = snapshotText();
    await verify(modal);
    await waitFor(() => expect(server.resolves(ORDER.manual)).toHaveLength(1));
    await settled(server);
    assertResolve(server.resolves(ORDER.manual)[0]!, issuedStepUp(1));
    await waitFor(() => expect(freshText(before)).toMatch(SETTLED_CLOSED));
    expect(freshText(before)).not.toMatch(SETTLED_PAID);
    await waitFor(() => expect(server.detailReads(ORDER.manual).length).toBeGreaterThan(reads));
    await settled(server);
    await waitFor(() => expect(showsStatus('CLOSED')).toBe(true));
    await waitFor(() => expect(resolveEntries()).toEqual([]));
    expect(refundEntries()).toEqual([]);
    onlyResolveSent(server);
  },
  FLOW_TIMEOUT,
);

it.each([
  { outcome: 'unknown', name: '渠道结果未知' },
  { outcome: 'not_exist', name: '渠道无此单但未过宽限（不关单）' },
] as const)(
  '[AC-F1-13b-RESOLVE#3] 【立即查询】$name：支付单仍待支付、仍需人工处置——提示未变化 / 稍后再查（不提示已支付或已关闭），重新读取详情，入口仍在',
  async ({ outcome }) => {
    const server = resolveServer();
    server.setResolveOutcome(outcome);
    await openDetail(server, ORDER.manual, OUT_TRADE_NO.manual);
    const modal = await startResolve();
    const reads = server.detailReads(ORDER.manual).length;
    const before = snapshotText();
    await verify(modal);
    await waitFor(() => expect(server.resolves(ORDER.manual)).toHaveLength(1));
    await settled(server);
    assertResolve(server.resolves(ORDER.manual)[0]!, issuedStepUp(1));
    await waitFor(() => expect(freshText(before)).toMatch(UNCHANGED));
    expect(freshText(before)).not.toMatch(SETTLED_PAID);
    expect(freshText(before)).not.toMatch(SETTLED_CLOSED);
    await waitFor(() => expect(server.detailReads(ORDER.manual).length).toBeGreaterThan(reads));
    await settled(server);
    expect(showsStatus('PENDING')).toBe(true);
    await waitFor(() => expect(resolveEntries().length).toBeGreaterThan(0));
    onlyResolveSent(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-RESOLVE#4] 服务端回 10003（需动态码）：不自动重发，再弹动态码；再次验证后用新的验证结果重发',
  async () => {
    const server = resolveServer();
    server.once('POST', resolvePath(ORDER.manual), stepUpRequired);
    await openDetail(server, ORDER.manual, OUT_TRADE_NO.manual);
    await verify(await startResolve());
    await waitFor(() => expect(server.resolves(ORDER.manual)).toHaveLength(1));
    await settled(server);
    const again = await stepUpDialog();
    expect(server.resolves(ORDER.manual), 'no resend before a new verification').toHaveLength(1);
    await verify(again);
    await waitFor(() => expect(server.resolves(ORDER.manual)).toHaveLength(2));
    await settled(server);
    const [first, second] = server.resolves(ORDER.manual);
    assertResolve(first!, issuedStepUp(1));
    assertResolve(second!, issuedStepUp(2));
    assertVerified(server, 2);
    onlyResolveSent(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-RESOLVE#5] 20902（支付单已不在人工处置）：提示状态已变化并重新读取详情，不重发；刷新后入口消失',
  async () => {
    const server = resolveServer();
    await openDetail(server, ORDER.manual, OUT_TRADE_NO.manual);
    const modal = await startResolve();
    // Meanwhile the automatic handling settled it as paid.
    Object.assign(
      server.state.find((row) => row.pay_order_id === ORDER.manual)!,
      {
        status: 'PAID',
        needs_manual: false,
        closing: false,
        paid_at: '2026-10-24T10:44:31+08:00',
      },
    );
    const reads = server.detailReads(ORDER.manual).length;
    const before = snapshotText();
    await verify(modal);
    await waitFor(() => expect(server.resolves(ORDER.manual)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(CONFLICT));
    await waitFor(() => expect(server.detailReads(ORDER.manual).length).toBeGreaterThan(reads));
    await settled(server);
    expect(server.resolves()).toHaveLength(1);
    await waitFor(() => expect(resolveEntries()).toEqual([]));
    onlyResolveSent(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-RESOLVE#6] 连续两次【立即查询】（第一次结果未变化）：第二次重新弹动态码，不复用第一次的验证结果',
  async () => {
    const server = resolveServer();
    await openDetail(server, ORDER.manual, OUT_TRADE_NO.manual);
    await verify(await startResolve());
    await waitFor(() => expect(server.resolves(ORDER.manual)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(stepUpOpen()).toBe(false));
    await waitFor(() => expect(resolveEntries().length).toBeGreaterThan(0));

    const second = await startResolve();
    expect(server.resolves(ORDER.manual), 'nothing sent before the new code').toHaveLength(1);
    assertVerified(server, 1);
    await verify(second);
    await waitFor(() => expect(server.resolves(ORDER.manual)).toHaveLength(2));
    await settled(server);
    const [first, again] = server.resolves(ORDER.manual);
    assertResolve(first!, issuedStepUp(1));
    assertResolve(again!, issuedStepUp(2));
    assertVerified(server, 2);
    onlyResolveSent(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-RESOLVE#7] 动态码弹窗点取消：不验证、不发 POST …/resolve，入口仍在',
  async () => {
    const server = resolveServer();
    await openDetail(server, ORDER.manual, OUT_TRADE_NO.manual);
    const modal = await startResolve();
    await click(within(modal).getByRole('button', { name: '取消' }));
    await settle();
    await waitFor(() => expect(stepUpOpen()).toBe(false));
    await settled(server);
    expect(server.resolves()).toEqual([]);
    expect(server.verifies()).toEqual([]);
    await waitFor(() => expect(resolveEntries().length).toBeGreaterThan(0));
    expect(server.writes()).toEqual([]);
  },
  FLOW_TIMEOUT,
);
