// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJUST_GRANTS,
  BATCH,
  BILL,
  SETTLE_GRANTS,
  SUPER,
  UPLOAD_GRANTS,
  VIEW_GRANTS,
  createServer,
  snapshot,
} from './fixtures.ts';
import {
  ENTRY,
  FLOW_TIMEOUT,
  ITEMS_ENTRY,
  VIEW_ENTRY,
  WRITE_ENTRY,
  assertNoStepUp,
  batchRow,
  batchRows,
  click,
  dismissStepUp,
  main,
  mount,
  open,
  openDetail,
  pageEntry,
  pressWrites,
  rowEntry,
  rowsWith,
  settle,
  settled,
  shown,
  stepUp,
  submitOf,
  usable,
} from './helpers.ts';

it(
  '[AC-F1-08db-ACCESS#1] 只持 fund.view：已出账与结算中账单的详情、批次明细都没有可用的写入口，点写名按钮也不发 POST、不弹动态码；同一账单持 settle.bill 时出现【确认立即执行】【定时执行】',
  async () => {
    const settler = createServer(undefined, { permissions: SETTLE_GRANTS });
    await openDetail(settler, BILL.issued);
    await pageEntry(ENTRY.confirmNow);
    await pageEntry(ENTRY.schedule);
    cleanup();

    for (const [billId, batchId] of [
      [BILL.issued, BATCH.issuedTaobao],
      [BILL.settling, BATCH.partial],
    ] as const) {
      const viewer = createServer(undefined, { permissions: VIEW_GRANTS });
      await openDetail(viewer, billId);
      expect(usable(document.body, WRITE_ENTRY), `no usable write on ${billId}`).toEqual([]);
      await pressWrites();
      const items = usable(batchRow(batchId), ITEMS_ENTRY);
      expect(items.length, `【明细】 of ${batchId.slice(0, 8)}`).toBeGreaterThan(0);
      await click(items[0]!);
      await waitFor(() => expect(viewer.itemReads(batchId).length).toBeGreaterThan(0));
      await settled(viewer);
      expect(usable(document.body, WRITE_ENTRY), 'no usable write with the items').toEqual([]);
      await pressWrites();
      await settled(viewer);
      expect(viewer.requests('POST'), 'no POST for fund.view').toEqual([]);
      assertNoStepUp(viewer);
      cleanup();
    }
  },
  FLOW_TIMEOUT,
);

it.each([
  ['settle.statement_upload', UPLOAD_GRANTS],
  ['fund.settle_adjust', ADJUST_GRANTS],
])(
  '[AC-F1-08db-ACCESS#2] 只持 %s：列表与详情地址都没有写入口、不发 POST、不弹动态码（无权限照旧）；持 settle.bill 时结算中账单的 PARTIAL 批次有【继续执行】、定时批次有【撤销定时】',
  async (_name, grants) => {
    const settler = createServer(undefined, { permissions: SETTLE_GRANTS });
    await openDetail(settler, BILL.settling);
    await rowEntry(BATCH.partial, ENTRY.resume);
    await rowEntry(BATCH.scheduled, ENTRY.cancelSchedule);
    cleanup();

    for (const route of ['settle-bills', `settle-bills/${BILL.settling}`]) {
      const server = createServer(undefined, { permissions: grants });
      await mount(server, { route, snapshot: snapshot(grants) });
      await settle();
      await settled(server);
      expect(usable(document.body, WRITE_ENTRY), `no usable write on ${route}`).toEqual([]);
      await pressWrites();
      await settled(server);
      expect(server.requests('POST'), `no POST on ${route}`).toEqual([]);
      assertNoStepUp(server);
      cleanup();
    }
  },
  FLOW_TIMEOUT,
);

it.each([
  ['settle.bill', snapshot(SETTLE_GRANTS)],
  ['超管', SUPER],
])(
  '[AC-F1-08db-ACCESS#3] %s 打开列表、结算中账单详情与批次明细都不弹动态码、不发 step-up 请求；点【撤销定时】并在确认框提交后才弹动态码，取消动态码不发写请求',
  async (_name, permissions) => {
    const server = createServer(undefined, { permissions: SETTLE_GRANTS });
    await mount(server, { snapshot: permissions });
    await waitFor(() =>
      expect(rowsWith(main(), [/(?<![\d-])2026-07(?!-?\d)/]), 'list row 2026-07').toHaveLength(1),
    );
    await settled(server);
    assertNoStepUp(server);

    const views = usable(rowsWith(main(), [/(?<![\d-])2026-07(?!-?\d)/])[0]!, VIEW_ENTRY);
    expect(views.length, '【查看】 of 2026-07').toBeGreaterThan(0);
    await click(views[0]!);
    await shown(server, BILL.settling);
    assertNoStepUp(server);

    const items = usable(batchRow(BATCH.partial), ITEMS_ENTRY);
    expect(items.length, '【明细】 of the PARTIAL batch').toBeGreaterThan(0);
    await click(items[0]!);
    await waitFor(() => expect(server.itemReads(BATCH.partial).length).toBeGreaterThan(0));
    await settled(server);
    assertNoStepUp(server);
    expect(server.requests('POST')).toEqual([]);

    const layer = await open(await rowEntry(BATCH.scheduled, ENTRY.cancelSchedule));
    expect(server.requests('POST'), 'no request when the confirmation opens').toEqual([]);
    await click(submitOf(layer));
    await stepUp();
    expect(server.writes(), 'no write before the step-up').toEqual([]);
    await dismissStepUp();
    await settled(server);
    expect(server.writes(), 'no write after cancelling the step-up').toEqual([]);
    expect(server.verifies(), 'no step-up request after cancelling').toEqual([]);
    expect(batchRows(BATCH.scheduled)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);
