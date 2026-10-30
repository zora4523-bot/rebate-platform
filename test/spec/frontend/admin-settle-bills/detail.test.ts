// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BATCH,
  BATCH_STATUS_NAME,
  BILL,
  CONFIRMER,
  SETTLE_MODE_NAME,
  VIEW_GRANTS,
  billPath,
  createServer,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  ITEMS_ENTRY,
  NOT_A_VALUE,
  NOT_FOUND,
  idRow,
  idRows,
  idToken,
  main,
  mount,
  openBill,
  settled,
  showsCount,
  showsYuan,
  squash,
  textOf,
  token,
  usable,
} from './helpers.ts';

const TAOBAO = /taobao|淘宝/;
const JD = /(?<![A-Za-z])jd(?![A-Za-z])|京东/;

it(
  '[AC-F1-08d-DETAIL#1] 【查看】结算中的账单：读 settle-bills/2026-07，显示账单状态、统计（子订单数、联盟结算佣金、受益人份额、平台留存，按分手算）与两个批次（批次号、平台、类型、子订单数、批次状态中文名、结算方式与定时时刻、确认人）',
  async () => {
    const server = createServer();
    await mount(server);
    const scope = await openBill(server, BILL.settling, BATCH.partial);
    await settled(server);
    expect(server.billReads(BILL.settling).length).toBeGreaterThan(0);
    const text = textOf(scope);
    // No admin_dict row for the bill status: the code shows.
    expect(text, 'bill status').toMatch(token('settling'));
    // Bill-day totals: taobao 980 + jd 120 sub-orders; 702550 + 88001 = 790551 fen.
    expect(
      showsCount(text, '1100') || (showsCount(text, '980') && showsCount(text, '120')),
      'sub-orders 1100 (980 + 120)',
    ).toBe(true);
    expect(
      showsYuan(text, '7905.51') || (showsYuan(text, '7025.50') && showsYuan(text, '880.01')),
      'union commission 7905.51 (7025.50 + 880.01)',
    ).toBe(true);
    expect(showsYuan(text, '5533.86'), 'beneficiary share 5533.86').toBe(true);
    expect(showsYuan(text, '2371.65'), 'platform retained 2371.65').toBe(true);

    const partial = textOf(idRow(BATCH.partial));
    expect(partial).toMatch(TAOBAO);
    expect(partial, 'kind main (no admin_dict row: the code)').toMatch(token('main'));
    expect(showsCount(partial, '975'), 'order_count 975').toBe(true);
    expect(squash(partial)).toContain(BATCH_STATUS_NAME.PARTIAL);
    expect(squash(partial)).toContain(SETTLE_MODE_NAME.IMMEDIATE);
    expect(partial, 'confirmed_by').toMatch(idToken(CONFIRMER.first));
    expect(partial).not.toMatch(NOT_A_VALUE);

    const scheduled = textOf(idRow(BATCH.scheduled));
    expect(scheduled).toMatch(JD);
    expect(scheduled).toMatch(token('main'));
    expect(showsCount(scheduled, '118'), 'order_count 118').toBe(true);
    expect(squash(scheduled)).toContain(BATCH_STATUS_NAME.CONFIRMED);
    expect(squash(scheduled)).toContain(SETTLE_MODE_NAME.SCHEDULED);
    expect(squash(scheduled), 'scheduled_at in Beijing time').toContain('2026-08-3110:00');
    expect(scheduled, 'confirmed_by').toMatch(idToken(CONFIRMER.second));
    expect(scheduled).not.toMatch(NOT_A_VALUE);

    for (const id of [BATCH.partial, BATCH.scheduled])
      expect(usable(idRow(id), ITEMS_ENTRY).length, `【明细】 of ${id.slice(0, 8)}`).toBe(1);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-DETAIL#2] 已结算账单的批次表：首批与补充批次都列出，类型显示 main / supplement（字典无行显示编码），批次状态「已完成」',
  async () => {
    const server = createServer();
    await mount(server);
    const scope = await openBill(server, BILL.settled, BATCH.doneMain);
    await waitFor(() => expect(idRows(BATCH.doneSupplement)).toHaveLength(1));
    expect(textOf(scope)).toMatch(token('settled'));
    const first = textOf(idRow(BATCH.doneMain));
    const supplement = textOf(idRow(BATCH.doneSupplement));
    expect(first).toMatch(token('main'));
    expect(supplement).toMatch(token('supplement'));
    expect(showsCount(first, '636')).toBe(true);
    expect(showsCount(supplement, '4')).toBe(true);
    for (const row of [first, supplement]) {
      expect(row).toMatch(TAOBAO);
      expect(squash(row)).toContain(BATCH_STATUS_NAME.DONE);
    }
    expect(first).toMatch(idToken(CONFIRMER.first));
    expect(supplement).toMatch(idToken(CONFIRMER.second));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-DETAIL#3] 详情地址 settle-bills/2026-08（只持 fund.view）：直接读该账单，两个待确认批次显示「待确认」，统计按分换算',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(server, { route: `settle-bills/${BILL.issued}` });
    await waitFor(() => expect(server.billReads(BILL.issued).length).toBeGreaterThan(0));
    await settled(server);
    for (const id of [BATCH.issuedTaobao, BATCH.issuedJd]) {
      await waitFor(() => expect(idRows(id), id.slice(0, 8)).toHaveLength(1));
      expect(squash(textOf(idRow(id)))).toContain(BATCH_STATUS_NAME.DRAFT);
    }
    expect(textOf(idRow(BATCH.issuedTaobao))).toMatch(TAOBAO);
    expect(textOf(idRow(BATCH.issuedJd))).toMatch(JD);
    const text = textOf(main());
    expect(text).toMatch(token('issued'));
    expect(showsYuan(text, '7120.34'), 'beneficiary share 7120.34').toBe(true);
    expect(showsYuan(text, '3029.83'), 'platform retained 3029.83').toBe(true);
    expect(
      showsYuan(text, '10150.17') || (showsYuan(text, '8640.12') && showsYuan(text, '1510.05')),
      'union commission 10150.17 (8640.12 + 1510.05)',
    ).toBe(true);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-DETAIL#4] 不存在的账单月（详情返回 20001 [bill_id]）：显示未找到类提示，不显示批次',
  async () => {
    const server = createServer();
    await mount(server, { route: 'settle-bills/2099-01' });
    await waitFor(() => expect(server.billReads('2099-01').length).toBeGreaterThan(0));
    await settled(server);
    expect(server.requests('GET', billPath('2099-01')).length).toBeGreaterThan(0);
    await waitFor(() => expect(squash(document.body.textContent)).toMatch(NOT_FOUND));
    for (const id of Object.values(BATCH)) expect(idRows(id), id.slice(0, 8)).toEqual([]);
  },
  FLOW_TIMEOUT,
);
