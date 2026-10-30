// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  FILTER_PARAMS,
  LIST_PARAMS,
  R4_NAMES,
  REF,
  SOURCE_NAME,
  STATUS_NAME,
  TYPE_NAME,
  VIEW_GRANTS,
  createServer,
  diffs,
  withFiller,
} from './fixtures.ts';
import {
  COLUMN,
  DETAIL_ENTRY,
  FLOW_TIMEOUT,
  LABEL,
  cellText,
  choose,
  extraParams,
  main,
  mount,
  nextPage,
  openDiffs,
  rowOf,
  rowsOf,
  scope,
  settled,
  showsAmount,
  squash,
  usable,
} from './helpers.ts';

it(
  '[AC-F1-08e-LIST#1] 进入后读第 1 页（page_size ≤ 200、不带筛选），按返回顺序列出六条差错单',
  async () => {
    const server = createServer();
    await mount(server);
    await openDiffs(server, REF.ledger);
    await settled(server);
    // Every read is a valid listAdminReconDiffs query (page_size ≤ 200)…
    for (const read of server.reads()) {
      expect(extraParams(read, LIST_PARAMS)).toEqual([]);
      const size = Number(read.query['page_size'] ?? '20');
      expect(size).toBeGreaterThanOrEqual(1);
      expect(size).toBeLessThanOrEqual(200);
    }
    // …and the table's read is page 1 without any filter (count reads with a status aside).
    const table = server
      .reads()
      .filter((read) => FILTER_PARAMS.every((name) => read.query[name] === undefined));
    expect(table.length, 'an unfiltered list read before any query').toBeGreaterThan(0);
    expect(table[0]!.query['page'] ?? '1').toBe('1');
    const order = diffs().map((item) => item.ref_id);
    const shown = order.map((ref) => rowsOf(scope(), [ref]));
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
  '[AC-F1-08e-LIST#2] 每行显示差错单号、类型中文名、来源、周期、关联单据、三项金额（元，两位小数）、状态中文名与【详情】',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(server);
    await openDiffs(server, REF.ledger);
    for (const item of diffs()) {
      const ref = item.ref_id;
      const row = rowOf(ref);
      expect(squash(row.textContent), `${ref} id`).toContain(item.recon_diff_id.slice(0, 8));
      expect(squash(cellText(ref, COLUMN.type)), `${ref} type`).toContain(TYPE_NAME[item.type]);
      expect(squash(cellText(ref, COLUMN.source)), `${ref} source`).toContain(
        SOURCE_NAME[item.source],
      );
      expect(squash(cellText(ref, COLUMN.period)), `${ref} period`).toContain(item.period);
      expect(squash(cellText(ref, COLUMN.ref)), `${ref} ref`).toContain(ref);
      expect(
        showsAmount(cellText(ref, COLUMN.expected), item.expected_fen),
        `${ref} 我方已记`,
      ).toBe(true);
      expect(showsAmount(cellText(ref, COLUMN.actual), item.actual_fen), `${ref} 对方`).toBe(true);
      expect(showsAmount(cellText(ref, COLUMN.diff), item.diff_fen), `${ref} 差额`).toBe(true);
      expect(squash(cellText(ref, COLUMN.status)), `${ref} status`).toContain(
        STATUS_NAME[item.status],
      );
      expect(usable(row, DETAIL_ENTRY).length, `${ref} 【详情】`).toBeGreaterThan(0);
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-LIST#3] 金额按分换算：1,234,567.89 / 1,234,570.00 / -2.11 与 0.00 / 15.00 / -15.00',
  async () => {
    const server = createServer();
    await mount(server);
    await openDiffs(server, REF.monthEnd);
    expect(showsAmount(cellText(REF.monthEnd, COLUMN.expected), 123456789)).toBe(true);
    expect(showsAmount(cellText(REF.monthEnd, COLUMN.actual), 123457000)).toBe(true);
    expect(showsAmount(cellText(REF.monthEnd, COLUMN.diff), -211)).toBe(true);
    expect(showsAmount(cellText(REF.appeal, COLUMN.expected), 0)).toBe(true);
    expect(showsAmount(cellText(REF.appeal, COLUMN.actual), 1500)).toBe(true);
    expect(showsAmount(cellText(REF.appeal, COLUMN.diff), -1500)).toBe(true);
    // A positive difference has no minus sign.
    expect(showsAmount(cellText(REF.settle, COLUMN.diff), 10000)).toBe(true);
    expect(showsAmount(cellText(REF.settle, COLUMN.diff), -10000)).toBe(false);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-LIST#4] 筛选项只给 R1–R3：来源三项、类型九项（无收款对账类），状态五项，名字取后台字典',
  async () => {
    const server = createServer();
    await mount(server);
    await openDiffs(server, REF.ledger);
    const sources = await choose(scope(), LABEL.source, /^联盟对账$/);
    for (const name of Object.values(SOURCE_NAME)) expect(sources).toContain(name);
    expect(sources).not.toContain(R4_NAMES.source);
    const types = await choose(scope(), LABEL.type, /^账实不符$/);
    for (const name of Object.values(TYPE_NAME)) expect(types).toContain(name);
    expect(types).not.toContain(R4_NAMES.payMismatch);
    expect(types).not.toContain(R4_NAMES.payAnomaly);
    const statuses = await choose(scope(), LABEL.status, /^待处理$/);
    for (const name of Object.values(STATUS_NAME)) expect(statuses).toContain(name);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-LIST#5] 页面提示收款对账（R4）的差错在支付单页处理',
  async () => {
    const server = createServer();
    await mount(server);
    await openDiffs(server, REF.ledger);
    const text = squash(main().textContent);
    expect(text).toMatch(/收款对账|R4/);
    expect(text).toContain('支付单');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08e-LIST#6] 页码分页：切到第 2 页请求 page=2（同一 page_size），显示该页的行、不再显示第 1 页的行',
  async () => {
    const server = createServer(withFiller(200));
    await mount(server);
    await openDiffs(server, REF.ledger);
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
    // The same page_size as the unfiltered page-1 read of the table.
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
    // The six samples come first, then the filler (one created_at, so id descending: fill-0200,
    // fill-0199, …); row index `size` (0-based) opens page 2.
    const firstOfPage = `fill-${String(206 - size).padStart(4, '0')}`;
    await waitFor(() => expect(rowsOf(scope(), [firstOfPage])).toHaveLength(1));
    expect(rowsOf(scope(), [REF.ledger])).toEqual([]);
  },
  FLOW_TIMEOUT,
);
