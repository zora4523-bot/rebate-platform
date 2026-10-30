// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BATCH,
  BILL,
  ITEM_PARAMS,
  ORDER,
  SKIP_REASON,
  USER,
  VIEW_GRANTS,
  createServer,
  fillerItems,
  fillerOrder,
  itemsPath,
  rejected,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  NOT_A_VALUE,
  NOT_FOUND,
  before,
  extraParams,
  idRow,
  idRows,
  idToken,
  mount,
  nextPageNear,
  openBill,
  openItems,
  settled,
  showsYuan,
  squash,
  textOf,
  token,
  told,
} from './helpers.ts';

/** A mainland mobile number (the contract carries user_id only, never a phone number). */
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const RESULTS = /(?<![A-Za-z])(?:credited|skipped|deferred)(?![A-Za-z])/;

it(
  '[AC-F1-08d-ITEMS#1] 【明细】读 settle-batches/{batch_id}/items（只带契约参数、第 1 页、page_size ≤ 200），逐行显示子订单 / 补记项、受益人、入账金额（按分手算）、结果（字典无行显示编码）与跳过原因',
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
    const credited = textOf(idRow(ORDER.credited));
    expect(showsYuan(credited, '720.12'), 'b_settle 720.12').toBe(true);
    expect(credited).toMatch(token('credited'));
    // Beneficiary make-up item: user_id and the credited amount 36 fen.
    const beneficiary = textOf(idRow(ORDER.beneficiary));
    expect(beneficiary, 'beneficiary user_id').toMatch(idToken(USER.direct));
    expect(showsYuan(beneficiary, '0.36'), 'amount 0.36').toBe(true);
    expect(beneficiary).toMatch(token('credited'));
    // Skipped order row with its reason.
    const skipped = textOf(idRow(ORDER.skipped));
    expect(showsYuan(skipped, '150.50'), 'b_settle 150.50').toBe(true);
    expect(skipped).toMatch(token('skipped'));
    expect(squash(skipped)).toContain(SKIP_REASON);
    // Deferred make-up item, amount not computed yet (null): not 0.00.
    const deferred = textOf(idRow(ORDER.deferred));
    expect(deferred).toMatch(idToken(USER.indirect));
    expect(deferred).toMatch(token('deferred'));
    expect(showsYuan(deferred, '0.00'), 'a null amount is not 0.00').toBe(false);
    // Not executed yet (result null): no result code.
    const pending = textOf(idRow(ORDER.pending));
    expect(showsYuan(pending, '99.99'), 'b_settle 99.99').toBe(true);
    expect(pending).not.toMatch(RESULTS);

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
