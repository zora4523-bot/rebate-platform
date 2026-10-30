// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BATCH,
  CHANNEL_SHOWN,
  CONDITION_NAME,
  FILTER_PARAMS,
  LIST_PARAMS,
  NO,
  REVIEWER,
  RISK_NAME,
  STATUS_NAME,
  VIEW_GRANTS,
  createServer,
  fillerNo,
  samples,
  withFiller,
} from './fixtures.ts';
import {
  AMOUNT_COLUMN,
  DETAIL_ENTRY,
  FLOW_TIMEOUT,
  cellText,
  extraParams,
  mount,
  moneyText,
  nextPage,
  openList,
  rowOf,
  rowsOf,
  scope,
  settled,
  showsYuan,
  squash,
  textOf,
  usable,
} from './helpers.ts';

it(
  '[AC-F1-08a-LIST#1] 进入后读第 1 页（page_size ≤ 200、不带筛选、只用契约参数），按返回顺序（申请时间倒序）列出七张提现单',
  async () => {
    const server = createServer();
    await mount(server);
    await openList(server, NO.pending);
    await settled(server);
    // Every read is a valid listAdminWithdrawals query (page_size ≤ 200)…
    for (const read of server.reads()) {
      expect(extraParams(read, LIST_PARAMS)).toEqual([]);
      const size = Number(read.query['page_size'] ?? '20');
      expect(size).toBeGreaterThanOrEqual(1);
      expect(size).toBeLessThanOrEqual(200);
    }
    // …and the table's read is page 1 without any filter (count reads of the tabs aside).
    const table = server
      .reads()
      .filter((read) => FILTER_PARAMS.every((name) => read.query[name] === undefined));
    expect(table.length, 'an unfiltered list read before any query').toBeGreaterThan(0);
    expect(table[0]!.query['page'] ?? '1').toBe('1');
    const order = samples().map((item) => item.out_biz_no);
    const shown = order.map((number) => rowsOf(scope(), [number]));
    for (const [index, rows] of shown.entries()) expect(rows, order[index]).toHaveLength(1);
    const nodes = shown.map((rows) => rows[0]!);
    // Node.DOCUMENT_POSITION_FOLLOWING, spelled out so no environment global is needed.
    const following = 0x4;
    for (let index = 1; index < nodes.length; index += 1) {
      const relation = nodes[index - 1]!.compareDocumentPosition(nodes[index]!);
      expect(relation & following, `${order[index]} after`).not.toBe(0);
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-LIST#2] 每行显示提现单号、用户（UID 与脱敏手机号）与收款方式、申请金额列与实付列各自的金额、状态中文名（admin_dict.withdrawal_status）、申请时间（北京时间）与【详情】',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(server);
    await openList(server, NO.pending);
    // Application times in Beijing time, written out by hand (spaces removed).
    const applied: Readonly<Record<string, string>> = {
      [NO.pending]: '2026-10-2910:00',
      [NO.autoPaid]: '2026-10-2809:30',
      [NO.approved]: '2026-10-2711:00',
      [NO.paying]: '2026-10-2514:00',
      [NO.rejected]: '2026-10-2008:00',
      [NO.manualPaid]: '2026-10-1016:00',
      [NO.failed]: '2026-10-0509:00',
    };
    for (const item of samples()) {
      const number = item.out_biz_no;
      const row = rowOf(number);
      const text = squash(row.textContent);
      expect(text, `${number} UID`).toContain(item.user.user_id.slice(0, 8));
      expect(text, `${number} phone`).toContain(item.user.phone_masked!);
      expect(textOf(row), `${number} channel`).toMatch(CHANNEL_SHOWN[item.payout_channel]);
      expect(text, `${number} status`).toContain(STATUS_NAME[item.status]);
      expect(text, `${number} applied at`).toContain(applied[number]!);
      expect(usable(row, DETAIL_ENTRY).length, `${number} 【详情】`).toBeGreaterThan(0);
    }
    // Amounts in their own columns, computed by hand from the fen of the samples: 申请金额
    // (amount_fen) and 实付 (net_fen); where the two differ, a swap fails.
    const amounts: Readonly<Record<string, { applied: string; net: string }>> = {
      [NO.pending]: { applied: '500.00', net: '500.00' },
      [NO.autoPaid]: { applied: '20.00', net: '20.00' },
      [NO.approved]: { applied: '1234.56', net: '1210.11' },
      [NO.paying]: { applied: '100.00', net: '100.00' },
      [NO.rejected]: { applied: '300.00', net: '300.00' },
      [NO.manualPaid]: { applied: '1234567.89', net: '1209876.53' },
      [NO.failed]: { applied: '88.00', net: '88.00' },
    };
    for (const [number, { applied, net }] of Object.entries(amounts)) {
      const appliedCell = cellText(number, AMOUNT_COLUMN.amount);
      const netCell = cellText(number, AMOUNT_COLUMN.net);
      expect(showsYuan(appliedCell, applied), `${number} 申请金额 ${applied}`).toBe(true);
      expect(showsYuan(netCell, net), `${number} 实付 ${net}`).toBe(true);
      if (applied !== net) {
        expect(showsYuan(appliedCell, net), `${number} 申请金额 is not ${net}`).toBe(false);
        expect(showsYuan(netCell, applied), `${number} 实付 is not ${applied}`).toBe(false);
      }
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-LIST#3] 金额按分换算为元：申请金额列与实付列不显示分值原数，千分位可有可无，两位小数（123456789 分 → 1,234,567.89）',
  async () => {
    const server = createServer();
    await mount(server);
    await openList(server, NO.manualPaid);
    const big = moneyText(cellText(NO.manualPaid, AMOUNT_COLUMN.amount));
    expect(showsYuan(big, '1234567.89')).toBe(true);
    expect(big, 'no raw fen').not.toMatch(/(?<![\d.])123456789(?![\d.])/);
    const bigNet = moneyText(cellText(NO.manualPaid, AMOUNT_COLUMN.net));
    expect(showsYuan(bigNet, '1209876.53')).toBe(true);
    expect(bigNet, 'no raw fen').not.toMatch(/(?<![\d.])120987653(?![\d.])/);
    const row = moneyText(textOf(rowOf(NO.approved)));
    expect(showsYuan(cellText(NO.approved, AMOUNT_COLUMN.amount), '1234.56')).toBe(true);
    expect(row, 'no raw fen').not.toMatch(/(?<![\d.])123456(?![\d.])/);
    expect(row, 'no raw fen').not.toMatch(/(?<![\d.])121011(?![\d.])/);
    // A small amount keeps its leading zero part (20 yuan, not 0.20 or 2000).
    const small = cellText(NO.autoPaid, AMOUNT_COLUMN.amount);
    expect(showsYuan(small, '20.00')).toBe(true);
    expect(showsYuan(small, '0.20')).toBe(false);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-LIST#4] 附加态与原因列：转人工原因与风险标签中文名取后台字典，「暂停」与「执行受阻」标记，驳回单显示审核人与驳回原因码，批次号',
  async () => {
    const server = createServer();
    await mount(server);
    await openList(server, NO.pending);
    const pending = squash(rowOf(NO.pending).textContent);
    expect(pending, '转人工原因 max_amount').toContain(CONDITION_NAME.max_amount);
    expect(pending, 'risk flag first_withdrawal').toContain(RISK_NAME.first_withdrawal!);
    expect(pending, '「暂停」 of blocked_reason').toMatch(/暂停|NEGATIVE_BALANCE/);
    const approved = squash(rowOf(NO.approved).textContent);
    expect(approved, '执行受阻 of execute_blocked').toMatch(/执行受阻|watermark_below_forecast/);
    expect(approved, 'batch').toContain(BATCH.approved.slice(0, 8));
    const rejected = squash(rowOf(NO.rejected).textContent);
    expect(rejected).toContain(RISK_NAME.same_device_multi_account!);
    expect(rejected).toContain(RISK_NAME.credited_today!);
    expect(rejected, '转人工原因 same_day').toContain(CONDITION_NAME.same_day);
    expect(rejected, 'reviewer').toContain(REVIEWER.slice(0, 8));
    expect(rejected, 'reject_reason_code (no dictionary row: the code)').toMatch(/RISK_SUSPECT/);
    expect(squash(rowOf(NO.manualPaid).textContent)).toContain(RISK_NAME.payee_prev_other_user!);
    expect(squash(rowOf(NO.autoPaid).textContent), 'batch').toContain(BATCH.autoPaid.slice(0, 8));
    // A row never carries the payee (the list has none): nothing like it is made up.
    for (const item of samples())
      expect(textOf(rowOf(item.out_biz_no)), `${item.out_biz_no} no payee`).not.toContain(
        item.payee.masked_account,
      );
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-LIST#5] 页码分页：切到第 2 页请求 page=2（同一 page_size），显示该页的行、不再显示第 1 页的行',
  async () => {
    const server = createServer(withFiller(200));
    await mount(server);
    await openList(server, NO.pending);
    await settled(server);
    const reads = server.reads().length;
    await nextPage();
    const paged = () =>
      server
        .reads()
        .slice(reads)
        .filter((read) => read.query['page'] === '2');
    await waitFor(() => expect(paged().length).toBeGreaterThan(0));
    await settled(server);
    const second = paged().at(-1)!;
    expect(extraParams(second, LIST_PARAMS)).toEqual([]);
    const size = Number(second.query['page_size'] ?? '20');
    const firstPages = server
      .reads()
      .slice(0, reads)
      .filter(
        (read) =>
          (read.query['page'] ?? '1') === '1' &&
          FILTER_PARAMS.every((name) => read.query[name] === undefined),
      );
    expect(
      firstPages.some((read) => Number(read.query['page_size'] ?? '20') === size),
      'page 2 keeps the page_size of page 1',
    ).toBe(true);
    // The seven samples come first, then the filler (one created_at, so id descending: n = 200,
    // 199, …); row index `size` (0-based) opens page 2.
    const firstOfPage = fillerNo(200 - (size - samples().length));
    await waitFor(() => expect(rowsOf(scope(), [firstOfPage])).toHaveLength(1));
    expect(rowsOf(scope(), [NO.pending])).toEqual([]);
  },
  FLOW_TIMEOUT,
);
