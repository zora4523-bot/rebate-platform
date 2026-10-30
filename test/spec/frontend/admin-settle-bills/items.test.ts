// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BATCH,
  BILL,
  ITEM_PARAMS,
  JD_ORDER,
  ORDER,
  SKIP_REASON,
  USER,
  VIEW_GRANTS,
  createServer,
  fillerItems,
  fillerOrder,
  itemsPath,
  namePattern,
  rejected,
  type Server,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  ITEM_COLUMN,
  ITEM_LABEL,
  NOT_A_VALUE,
  NOT_FOUND,
  QUERY,
  before,
  cellText,
  choose,
  click,
  combobox,
  extraParams,
  idRow,
  idRows,
  idToken,
  mount,
  nearestUsable,
  nextPageNear,
  openBill,
  openItems,
  settle,
  settled,
  showsName,
  showsYuan,
  squash,
  textOf,
  told,
} from './helpers.ts';

/** A mainland mobile number (the contract carries user_id only, never a phone number). */
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const RESULT_CODES = ['credited', 'skipped', 'deferred'] as const;
const BATCHES = '/admin/v1/settle-batches/';

/** The result cell of `row` shows no result (the item is not executed yet). */
function showsNoResult(row: HTMLElement): boolean {
  const cell = cellText(row, ITEM_COLUMN.result);
  return RESULT_CODES.every((code) => !showsName(cell, 'itemResult', code));
}

/**
 * Chooses the item type and result in the items filter (options named as the dictionary has them,
 * the code without a row), presses the filter's 【查询】 unless the choice already re-read, and
 * returns the items read that carries both.
 */
async function filterItems(server: Server, batchId: string, type: string, result: string) {
  const reads = server.itemReads(batchId).length;
  await choose(document.body, ITEM_LABEL.type, namePattern('itemType', type, true));
  await choose(document.body, ITEM_LABEL.result, namePattern('itemResult', result, true));
  await settle();
  const filtered = () =>
    server
      .itemReads(batchId)
      .slice(reads)
      .filter((read) => read.query['item_type'] === type && read.query['result'] === result);
  if (filtered().length === 0) {
    const button = nearestUsable(combobox(document.body, ITEM_LABEL.type), QUERY);
    expect(button, 'a 【查询】 of the items filter (or filtering on change)').toBeDefined();
    await click(button!);
  }
  await waitFor(() =>
    expect(filtered().length, `items read ${type} / ${result}`).toBeGreaterThan(0),
  );
  await settled(server);
  return filtered().at(-1)!;
}

it(
  '[AC-F1-08d-ITEMS#1] 【明细】读 settle-batches/{batch_id}/items（只带契约参数、第 1 页、page_size ≤ 200），逐行显示子订单 / 补记项、类型（字典名，缺键显示编码）、受益人、入账金额（按分手算）、结果（同上）与跳过原因',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(server, { route: `settle-bills/${BILL.settling}` });
    await waitFor(() => expect(idRows(BATCH.partial)).toHaveLength(1));
    await openItems(server, BATCH.partial);
    for (const read of server.itemReads(BATCH.partial)) {
      expect(extraParams(read.query, ITEM_PARAMS)).toEqual([]);
      const size = Number(read.query['page_size'] ?? '20');
      expect(size).toBeGreaterThanOrEqual(1);
      expect(size).toBeLessThanOrEqual(200);
    }
    expect(server.itemReads(BATCH.partial)[0]!.query['page'] ?? '1').toBe('1');
    for (const id of Object.values(ORDER))
      await waitFor(() => expect(idRows(id), id.slice(0, 8)).toHaveLength(1));

    // Order row: B_settle 72012 fen.
    const creditedRow = idRow(ORDER.credited);
    expect(showsYuan(textOf(creditedRow), '720.12'), 'b_settle 720.12').toBe(true);
    const creditedType = cellText(creditedRow, ITEM_COLUMN.type);
    expect(showsName(creditedType, 'itemType', 'order'), 'type order').toBe(true);
    expect(showsName(creditedType, 'itemType', 'beneficiary'), 'not beneficiary').toBe(false);
    expect(showsName(cellText(creditedRow, ITEM_COLUMN.result), 'itemResult', 'credited')).toBe(
      true,
    );
    // Beneficiary make-up item: user_id and the credited amount 36 fen.
    const beneficiaryRow = idRow(ORDER.beneficiary);
    const beneficiary = textOf(beneficiaryRow);
    expect(beneficiary, 'beneficiary user_id').toMatch(idToken(USER.direct));
    expect(showsYuan(beneficiary, '0.36'), 'amount 0.36').toBe(true);
    const beneficiaryType = cellText(beneficiaryRow, ITEM_COLUMN.type);
    expect(showsName(beneficiaryType, 'itemType', 'beneficiary'), 'type beneficiary').toBe(true);
    expect(showsName(beneficiaryType, 'itemType', 'order'), 'not order').toBe(false);
    expect(showsName(cellText(beneficiaryRow, ITEM_COLUMN.result), 'itemResult', 'credited')).toBe(
      true,
    );
    // Skipped order row with its reason.
    const skippedRow = idRow(ORDER.skipped);
    expect(showsYuan(textOf(skippedRow), '150.50'), 'b_settle 150.50').toBe(true);
    expect(showsName(cellText(skippedRow, ITEM_COLUMN.type), 'itemType', 'order')).toBe(true);
    expect(showsName(cellText(skippedRow, ITEM_COLUMN.result), 'itemResult', 'skipped')).toBe(true);
    expect(squash(cellText(skippedRow, ITEM_COLUMN.reason))).toContain(SKIP_REASON);
    // Deferred make-up item, amount not computed yet (null): not 0.00.
    const deferredRow = idRow(ORDER.deferred);
    const deferred = textOf(deferredRow);
    expect(deferred).toMatch(idToken(USER.indirect));
    expect(showsName(cellText(deferredRow, ITEM_COLUMN.type), 'itemType', 'beneficiary')).toBe(
      true,
    );
    expect(showsName(cellText(deferredRow, ITEM_COLUMN.result), 'itemResult', 'deferred')).toBe(
      true,
    );
    expect(showsYuan(deferred, '0.00'), 'a null amount is not 0.00').toBe(false);
    // Not executed yet (result null): no result.
    const pendingRow = idRow(ORDER.pending);
    expect(showsYuan(textOf(pendingRow), '99.99'), 'b_settle 99.99').toBe(true);
    expect(showsName(cellText(pendingRow, ITEM_COLUMN.type), 'itemType', 'order')).toBe(true);
    expect(showsNoResult(pendingRow), 'no result while not executed').toBe(true);

    for (const id of Object.values(ORDER))
      expect(textOf(idRow(id)), id.slice(0, 8)).not.toMatch(NOT_A_VALUE);
    expect(document.body.textContent ?? '', 'no phone number').not.toMatch(PHONE);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-ITEMS#2] 明细分页：切到第 2 页请求 page=2（同一 page_size），显示该页的明细、不再显示第 1 页的明细',
  async () => {
    const server = createServer(undefined, { items: { [BATCH.doneMain]: fillerItems(205) } });
    await mount(server);
    await openBill(server, BILL.settled, BATCH.doneMain);
    await openItems(server, BATCH.doneMain);
    await waitFor(() => expect(idRows(fillerOrder(1))).toHaveLength(1));
    const reads = server.itemReads(BATCH.doneMain).length;
    const firstSize = Number(server.itemReads(BATCH.doneMain).at(-1)!.query['page_size'] ?? '20');
    await nextPageNear(idRow(fillerOrder(1)));
    const paged = () =>
      server
        .itemReads(BATCH.doneMain)
        .slice(reads)
        .filter((read) => read.query['page'] === '2');
    await waitFor(() => expect(paged().length).toBeGreaterThan(0));
    await settled(server);
    const second = paged().at(-1)!;
    expect(extraParams(second.query, ITEM_PARAMS)).toEqual([]);
    const size = Number(second.query['page_size'] ?? '20');
    expect(size, 'page 2 keeps the page_size of page 1').toBe(firstSize);
    // settle_seq ascending from 1: row index `size` (0-based) is item size + 1.
    await waitFor(() => expect(idRows(fillerOrder(size + 1))).toHaveLength(1));
    expect(idRows(fillerOrder(1))).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-ITEMS#3] 批次不存在（明细返回 20001 [batch_id]）：给出未找到类提示，不显示明细行',
  async () => {
    const server = createServer();
    await mount(server, { route: `settle-bills/${BILL.settling}` });
    await waitFor(() => expect(idRows(BATCH.partial)).toHaveLength(1));
    await settled(server);
    server.once('GET', itemsPath(BATCH.partial), () => rejected(['batch_id']));
    const prior = before();
    await openItems(server, BATCH.partial);
    await waitFor(() => expect(told(prior, NOT_FOUND), 'a not-found notice').toBe(true));
    for (const id of Object.values(ORDER)) expect(idRows(id), id.slice(0, 8)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-ITEMS#4] 第二个批次的【明细】：只读该批次的 items（不读第一个批次），显示该批次的明细（类型、受益人、金额），负的结算金额保留负号（−1234 分 = -12.34）',
  async () => {
    const server = createServer();
    await mount(server);
    await openBill(server, BILL.settling, BATCH.partial);
    await waitFor(() => expect(idRows(BATCH.scheduled)).toHaveLength(1));
    await openItems(server, BATCH.scheduled);
    expect(server.itemReads(BATCH.scheduled).length).toBeGreaterThan(0);
    expect(server.itemReads(BATCH.partial), 'the first batch is not read').toEqual([]);
    const batchReads = server.log.filter((read) => read.path.startsWith(BATCHES));
    for (const read of batchReads)
      expect(read.path, 'only the second batch').toBe(itemsPath(BATCH.scheduled));
    for (const id of Object.values(JD_ORDER))
      await waitFor(() => expect(idRows(id), id.slice(0, 8)).toHaveLength(1));
    for (const id of Object.values(ORDER))
      expect(idRows(id), `no item of the first batch ${id.slice(0, 8)}`).toEqual([]);

    // B_settle −1234 fen: the minus sign stays.
    const adjustedRow = idRow(JD_ORDER.adjusted);
    expect(showsYuan(textOf(adjustedRow), '-12.34'), 'b_settle -12.34 with its sign').toBe(true);
    expect(showsName(cellText(adjustedRow, ITEM_COLUMN.type), 'itemType', 'order')).toBe(true);
    // B_settle 5678 fen.
    const plainRow = idRow(JD_ORDER.plain);
    expect(showsYuan(textOf(plainRow), '56.78'), 'b_settle 56.78').toBe(true);
    expect(showsName(cellText(plainRow, ITEM_COLUMN.type), 'itemType', 'order')).toBe(true);
    // Beneficiary make-up item (share): its user_id, amount not computed yet.
    const sharedRow = idRow(JD_ORDER.shared);
    expect(textOf(sharedRow), 'beneficiary user_id').toMatch(idToken(USER.share));
    expect(showsName(cellText(sharedRow, ITEM_COLUMN.type), 'itemType', 'beneficiary')).toBe(true);
    expect(showsYuan(textOf(sharedRow), '0.00'), 'a null amount is not 0.00').toBe(false);
    for (const id of Object.values(JD_ORDER)) {
      expect(showsNoResult(idRow(id)), `${id.slice(0, 8)} not executed`).toBe(true);
      expect(textOf(idRow(id)), id.slice(0, 8)).not.toMatch(NOT_A_VALUE);
    }
    expect(document.body.textContent ?? '', 'no phone number').not.toMatch(PHONE);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-ITEMS#5] 明细筛选：选类型 order、结果 pending（未执行）后请求带 item_type=order、result=pending（契约参数名），从第 1 页起，只列命中的明细',
  async () => {
    const server = createServer();
    await mount(server, { route: `settle-bills/${BILL.settling}` });
    await waitFor(() => expect(idRows(BATCH.partial)).toHaveLength(1));
    await openItems(server, BATCH.partial);
    for (const id of Object.values(ORDER))
      await waitFor(() => expect(idRows(id), id.slice(0, 8)).toHaveLength(1));
    const sent = await filterItems(server, BATCH.partial, 'order', 'pending');
    expect(sent.query).toMatchObject({ item_type: 'order', result: 'pending' });
    expect(sent.query['page'] ?? '1').toBe('1');
    expect(extraParams(sent.query, ITEM_PARAMS)).toEqual([]);
    await waitFor(() => expect(idRows(ORDER.credited)).toEqual([]));
    expect(idRows(ORDER.pending)).toHaveLength(1);
    for (const id of [ORDER.beneficiary, ORDER.skipped, ORDER.deferred])
      expect(idRows(id), id.slice(0, 8)).toEqual([]);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-ITEMS#6] 筛选后翻页：item_type=order、result=credited 下切到第 2 页请求 page=2 并保留两个筛选参数与 page_size',
  async () => {
    const server = createServer(undefined, { items: { [BATCH.doneMain]: fillerItems(205) } });
    await mount(server, { route: `settle-bills/${BILL.settled}` });
    await waitFor(() => expect(idRows(BATCH.doneMain)).toHaveLength(1));
    await openItems(server, BATCH.doneMain);
    await waitFor(() => expect(idRows(fillerOrder(1))).toHaveLength(1));
    const first = await filterItems(server, BATCH.doneMain, 'order', 'credited');
    expect(first.query['page'] ?? '1').toBe('1');
    const firstSize = Number(first.query['page_size'] ?? '20');
    await waitFor(() => expect(idRows(fillerOrder(1))).toHaveLength(1));
    const reads = server.itemReads(BATCH.doneMain).length;
    await nextPageNear(idRow(fillerOrder(1)));
    const paged = () =>
      server
        .itemReads(BATCH.doneMain)
        .slice(reads)
        .filter((read) => read.query['page'] === '2');
    await waitFor(() => expect(paged().length).toBeGreaterThan(0));
    await settled(server);
    const second = paged().at(-1)!;
    expect(second.query).toMatchObject({ item_type: 'order', result: 'credited', page: '2' });
    expect(extraParams(second.query, ITEM_PARAMS)).toEqual([]);
    const size = Number(second.query['page_size'] ?? '20');
    expect(size, 'page 2 keeps the page_size').toBe(firstSize);
    await waitFor(() => expect(idRows(fillerOrder(size + 1))).toHaveLength(1));
    expect(idRows(fillerOrder(1))).toEqual([]);
  },
  FLOW_TIMEOUT,
);
