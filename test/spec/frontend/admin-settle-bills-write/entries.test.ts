// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BATCH, BILL, SUPER, bills, createServer, type Bill } from './fixtures.ts';
import {
  ENTRY,
  FLOW_TIMEOUT,
  WRITE_ENTRY,
  actions,
  assertNoStepUp,
  batchRow,
  click,
  closeConfirmations,
  isDisabled,
  main,
  openDetail,
  openReject,
  pageEntry,
  pressWrites,
  rowEntry,
  rowShows,
  settled,
  usable,
} from './helpers.ts';

/** The usable write entries of the row of `batchId`, by text. */
function rowWrites(batchId: string): string[] {
  return usable(batchRow(batchId), WRITE_ENTRY).map((node) => node.textContent ?? '');
}

/** The samples with the jd batch of the settling bill confirmed IMMEDIATE (not started yet). */
function immediateConfirmed(): Bill[] {
  const all = bills();
  const settling = all.find((bill) => bill.bill_id === BILL.settling)!;
  const jd = settling.batches.find((one) => one.batch_id === BATCH.scheduled)!;
  jd.settle_mode = 'IMMEDIATE';
  jd.scheduled_at = null;
  return all;
}

it(
  '[AC-F1-08db-ENTRY#1] 已出账账单（两个待确认批次）：标题区有【确认立即执行】【定时执行】，每个待确认批次都能发起【驳回】（批次行里，或标题区选定该批次），批次行没有【撤销定时】【继续执行】；有待确认批次时没有可用的【发起补充批次】；写按钮名不含「重试」；只打开驳回框不发 POST、不弹动态码',
  async () => {
    const server = createServer();
    await openDetail(server, BILL.issued);
    await pageEntry(ENTRY.confirmNow);
    await pageEntry(ENTRY.schedule);
    for (const id of [BATCH.issuedTaobao, BATCH.issuedJd]) {
      expect(usable(batchRow(id), ENTRY.cancelSchedule), id.slice(0, 8)).toEqual([]);
      expect(usable(batchRow(id), ENTRY.resume), id.slice(0, 8)).toEqual([]);
    }
    expect(usable(main(), ENTRY.supplement), 'no supplement launch while DRAFT waits').toEqual([]);
    expect(actions(main(), /重试/), 'no write button named 重试').toEqual([]);
    for (const id of [BATCH.issuedTaobao, BATCH.issuedJd]) {
      await openReject(server, BILL.issued, id);
      await closeConfirmations();
    }
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    assertNoStepUp(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-ENTRY#2] 结算中账单：PARTIAL 批次只有【继续执行】、定时未开始的 CONFIRMED 批次只有【撤销定时】，页面上没有可用的【驳回】；没有待确认批次时标题区没有可用的【确认立即执行】【定时执行】，有【发起补充批次】；点不可用的写入口不发 POST',
  async () => {
    const server = createServer();
    await openDetail(server, BILL.settling);
    await rowEntry(BATCH.partial, ENTRY.resume);
    await rowEntry(BATCH.scheduled, ENTRY.cancelSchedule);
    expect(rowWrites(BATCH.partial).map((text) => text.replace(/\s+/g, ''))).toEqual(['继续执行']);
    expect(rowWrites(BATCH.scheduled).map((text) => text.replace(/\s+/g, ''))).toEqual([
      '撤销定时',
    ]);
    expect(usable(main(), ENTRY.reject), 'no 【驳回】 without DRAFT').toEqual([]);
    expect(usable(main(), ENTRY.confirmNow), 'no 【确认立即执行】 without DRAFT').toEqual([]);
    expect(usable(main(), ENTRY.schedule), 'no 【定时执行】 without DRAFT').toEqual([]);
    await pageEntry(ENTRY.supplement);
    for (const node of actions(document.body, WRITE_ENTRY).filter(isDisabled)) await click(node);
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    assertNoStepUp(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-ENTRY#3] 已结算账单（批次全部 DONE）：批次行没有任何写入口、标题区没有确认 / 定时 / 驳回，只有【发起补充批次】；出账中账单没有任何可用写入口，点写名按钮不发 POST',
  async () => {
    const settledServer = createServer();
    await openDetail(settledServer, BILL.settled);
    await pageEntry(ENTRY.supplement);
    for (const id of [BATCH.doneMain, BATCH.doneSupplement])
      expect(rowWrites(id), `no write on DONE ${id.slice(0, 8)}`).toEqual([]);
    expect(usable(main(), ENTRY.confirmNow)).toEqual([]);
    expect(usable(main(), ENTRY.schedule)).toEqual([]);
    expect(usable(main(), ENTRY.reject)).toEqual([]);
    expect(settledServer.requests('POST')).toEqual([]);
    cleanup();

    const generating = createServer();
    await openDetail(generating, BILL.generating);
    await settled(generating);
    expect(usable(document.body, WRITE_ENTRY), 'no usable write while generating').toEqual([]);
    await pressWrites();
    await settled(generating);
    expect(generating.requests('POST')).toEqual([]);
    assertNoStepUp(generating);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-ENTRY#4] 超管看账单（含上一轮之外的待确认批次）：【确认立即执行】【定时执行】可用，两个待确认批次（含 in_current_round=false 的）都能发起【驳回】，已完成与已取消的批次没有写入口',
  async () => {
    const server = createServer();
    await openDetail(server, BILL.rounds, SUPER);
    await pageEntry(ENTRY.confirmNow);
    await pageEntry(ENTRY.schedule);
    for (const id of [BATCH.doneJd, BATCH.rejected])
      expect(rowWrites(id), `no write on ${id.slice(0, 8)}`).toEqual([]);
    expect(usable(main(), ENTRY.supplement), 'no supplement launch while DRAFT waits').toEqual([]);
    for (const id of [BATCH.staleDraft, BATCH.freshDraft]) {
      await openReject(server, BILL.rounds, id);
      await closeConfirmations();
    }
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-ENTRY#5] 结算中账单里已确认、settle_mode=IMMEDIATE 且未开始的批次：没有可用的【撤销定时】（也没有【驳回】【继续执行】），点该名字的按钮不发 POST、不弹动态码；同一账单的 PARTIAL 批次仍有【继续执行】',
  async () => {
    const server = createServer(immediateConfirmed());
    await openDetail(server, BILL.settling);
    await rowEntry(BATCH.partial, ENTRY.resume);
    await rowShows(BATCH.scheduled, 'batchStatus', 'CONFIRMED');
    expect(usable(batchRow(BATCH.scheduled), ENTRY.cancelSchedule), 'no 【撤销定时】').toEqual([]);
    expect(rowWrites(BATCH.scheduled), 'no write on the IMMEDIATE batch').toEqual([]);
    expect(usable(main(), ENTRY.cancelSchedule), 'no 【撤销定时】 anywhere').toEqual([]);
    for (const node of actions(document.body, ENTRY.cancelSchedule)) await click(node);
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    assertNoStepUp(server);
  },
  FLOW_TIMEOUT,
);
