// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BILL,
  FILTER_PARAMS,
  LIST_PARAMS,
  VIEW_GRANTS,
  createServer,
  monthBefore,
  withFillerBills,
} from './fixtures.ts';
import {
  COLUMN,
  FLOW_TIMEOUT,
  NOT_A_VALUE,
  VIEW_ENTRY,
  billRow,
  billRows,
  cellText,
  extraParams,
  listed,
  mount,
  nextPageNear,
  settled,
  showsCount,
  showsName,
  showsYuan,
  squash,
  textOf,
  usable,
} from './helpers.ts';

interface Expected {
  readonly month: string;
  readonly status: string;
  readonly generated: string;
  readonly countTotal: string;
  readonly countEach: readonly string[];
  readonly commissionTotal: string;
  readonly commissionEach: readonly string[];
  readonly beneficiary: string;
  readonly retained: string;
  readonly errors: string;
  readonly held: string;
}

/**
 * Expected cells of the three generated samples, computed by hand from the fen in fixtures.ts;
 * within a row every value differs, so a value shown under another column's title fails. The
 * commission column may show the bill's total over platforms or each platform's amount; the
 * sub-order column likewise the total count or each platform's count.
 */
const EXPECTED: readonly Expected[] = [
  {
    month: BILL.issued,
    status: 'issued',
    generated: '2026-09-2402:10',
    // taobao 1200 + jd 300
    countTotal: '1500',
    countEach: ['1200', '300'],
    // taobao 864012 + jd 151005 = 1015017 fen
    commissionTotal: '10150.17',
    commissionEach: ['8640.12', '1510.05'],
    // 712034 fen
    beneficiary: '7120.34',
    // 302983 fen
    retained: '3029.83',
    errors: '4',
    held: '2',
  },
  {
    month: BILL.settling,
    status: 'settling',
    generated: '2026-08-2402:11',
    // taobao 980 + jd 120
    countTotal: '1100',
    countEach: ['980', '120'],
    // taobao 702550 + jd 88001 = 790551 fen
    commissionTotal: '7905.51',
    commissionEach: ['7025.50', '880.01'],
    // 553386 fen
    beneficiary: '5533.86',
    // 237165 fen
    retained: '2371.65',
    errors: '0',
    held: '1',
  },
  {
    month: BILL.settled,
    status: 'settled',
    generated: '2026-07-2402:09',
    countTotal: '640',
    countEach: ['640'],
    // 450000 fen
    commissionTotal: '4500.00',
    commissionEach: ['4500.00'],
    // 315000 fen
    beneficiary: '3150.00',
    // 135000 fen
    retained: '1350.00',
    errors: '1',
    held: '0',
  },
];

/** A cell whose one number is `count` (a unit or a link may surround it). */
function onlyNumber(count: string): RegExp {
  return new RegExp(`^\\D*${count}\\D*$`);
}
function showsCommission(text: string, expected: Expected): boolean {
  return (
    showsYuan(text, expected.commissionTotal) ||
    expected.commissionEach.every((yuan) => showsYuan(text, yuan))
  );
}
function showsAnyCommission(text: string, expected: Expected): boolean {
  return [expected.commissionTotal, ...expected.commissionEach].some((yuan) =>
    showsYuan(text, yuan),
  );
}
function showsOrders(text: string, expected: Expected): boolean {
  return (
    showsCount(text, expected.countTotal) ||
    expected.countEach.every((count) => showsCount(text, count))
  );
}

it(
  '[AC-F1-08d-LIST#1] 进入后读第 1 页（page_size ≤ 200、不带筛选），按返回顺序（账单月倒序）列出四张账单',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(BILL.issued);
    await settled(server);
    for (const read of server.reads()) {
      expect(extraParams(read.query, LIST_PARAMS)).toEqual([]);
      const size = Number(read.query['page_size'] ?? '20');
      expect(size).toBeGreaterThanOrEqual(1);
      expect(size).toBeLessThanOrEqual(200);
    }
    // The table's read (count reads with their own parameters aside).
    const first = server.tableReads()[0];
    expect(first, 'an unfiltered table read').toBeDefined();
    expect(first!.query['page'] ?? '1').toBe('1');
    for (const name of FILTER_PARAMS) expect(first!.query[name], `no ${name}`).toBeUndefined();
    const order = [BILL.generating, BILL.issued, BILL.settling, BILL.settled];
    const nodes = order.map((month) => billRow(month));
    // Node.DOCUMENT_POSITION_FOLLOWING, spelled out so no environment global is needed.
    const following = 0x4;
    for (let index = 1; index < nodes.length; index += 1) {
      const relation = nodes[index - 1]!.compareDocumentPosition(nodes[index]!);
      expect(relation & following, `${order[index]} after ${order[index - 1]}`).not.toBe(0);
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-LIST#2] 每行在各自的列下显示账单状态（字典名，缺键显示编码）、生成时间、子订单数、联盟结算佣金、受益人份额、平台留存（元，两位小数，按分手算）、差错单、暂缓，并有【查看】',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(server);
    await listed(BILL.settled);
    for (const expected of EXPECTED) {
      const row = billRow(expected.month);
      const label = expected.month;
      const status = cellText(row, COLUMN.status);
      expect(showsName(status, 'billStatus', expected.status), `${label} status`).toBe(true);
      expect(squash(cellText(row, COLUMN.generated)), `${label} generated_at (Beijing)`).toContain(
        expected.generated,
      );

      const orders = cellText(row, COLUMN.orders);
      expect(showsOrders(orders, expected), `${label} sub-orders ${expected.countTotal}`).toBe(
        true,
      );

      const commission = cellText(row, COLUMN.commission);
      expect(showsCommission(commission, expected), `${label} union commission`).toBe(true);
      expect(showsYuan(commission, expected.beneficiary), `${label} commission ≠ share`).toBe(
        false,
      );
      expect(showsYuan(commission, expected.retained), `${label} commission ≠ retained`).toBe(
        false,
      );

      const beneficiary = cellText(row, COLUMN.beneficiary);
      expect(showsYuan(beneficiary, expected.beneficiary), `${label} beneficiary share`).toBe(true);
      expect(showsAnyCommission(beneficiary, expected), `${label} share ≠ commission`).toBe(false);
      expect(showsYuan(beneficiary, expected.retained), `${label} share ≠ retained`).toBe(false);

      const retained = cellText(row, COLUMN.retained);
      expect(showsYuan(retained, expected.retained), `${label} platform retained`).toBe(true);
      expect(showsAnyCommission(retained, expected), `${label} retained ≠ commission`).toBe(false);
      expect(showsYuan(retained, expected.beneficiary), `${label} retained ≠ share`).toBe(false);

      expect(squash(cellText(row, COLUMN.errors)), `${label} 差错单`).toMatch(
        onlyNumber(expected.errors),
      );
      expect(squash(cellText(row, COLUMN.held)), `${label} 暂缓`).toMatch(
        onlyNumber(expected.held),
      );
      expect(textOf(row), `${label} no raw value`).not.toMatch(NOT_A_VALUE);
      expect(usable(row, VIEW_ENTRY).length, `${label} 【查看】`).toBeGreaterThan(0);
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-LIST#3] 出账中的账单（generated_at 与各合计为 null）：状态显示字典名（缺键显示编码），合计不显示为 0.00、NaN 或 null',
  async () => {
    const server = createServer();
    await mount(server);
    const row = await listed(BILL.generating);
    const text = textOf(row);
    expect(showsName(cellText(row, COLUMN.status), 'billStatus', 'generating')).toBe(true);
    expect(text).not.toMatch(NOT_A_VALUE);
    expect(showsYuan(text, '0.00'), 'a null total is not 0.00').toBe(false);
    expect(squash(cellText(row, COLUMN.errors)), 'a null 差错单 is not 0').not.toMatch(
      onlyNumber('0'),
    );
    expect(squash(cellText(row, COLUMN.held)), 'a null 暂缓 is not 0').not.toMatch(onlyNumber('0'));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-LIST#4] 页码分页：切到第 2 页请求 page=2（同一 page_size），显示该页的账单、不再显示第 1 页的账单',
  async () => {
    const server = createServer(withFillerBills(205));
    await mount(server);
    await listed(BILL.issued);
    await settled(server);
    const reads = server.tableReads().length;
    const firstSize = Number(server.tableReads().at(-1)!.query['page_size'] ?? '20');
    await nextPageNear(billRow(BILL.issued));
    const paged = () =>
      server
        .tableReads()
        .slice(reads)
        .filter((read) => read.query['page'] === '2');
    await waitFor(() => expect(paged().length).toBeGreaterThan(0));
    await settled(server);
    const second = paged().at(-1)!;
    expect(extraParams(second.query, LIST_PARAMS)).toEqual([]);
    const size = Number(second.query['page_size'] ?? '20');
    expect(size, 'page 2 keeps the page_size of page 1').toBe(firstSize);
    // bill_id descending from 2026-09, one bill a month: row index `size` opens page 2.
    const firstOfPage = monthBefore(BILL.generating, size);
    await waitFor(() => expect(billRows(firstOfPage), firstOfPage).toHaveLength(1));
    expect(billRows(BILL.issued)).toEqual([]);
  },
  FLOW_TIMEOUT,
);
