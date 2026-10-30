// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BATCH, BILL, CONFIRMER, VIEW_GRANTS, billPath, createServer } from './fixtures.ts';
import {
  BATCH_COLUMN,
  FLOW_TIMEOUT,
  ITEMS_ENTRY,
  NOT_A_VALUE,
  NOT_FOUND,
  STAT,
  cellText,
  detailScope,
  idRow,
  idRows,
  idToken,
  labelledTexts,
  mount,
  openBill,
  settled,
  showsCount,
  showsName,
  showsYuan,
  squash,
  textOf,
  usable,
} from './helpers.ts';

const TAOBAO = /taobao|淘宝/;
const JD = /(?<![A-Za-z])jd(?![A-Za-z])|京东/;

interface Stats {
  readonly countTotal: string;
  readonly countEach: readonly string[];
  readonly commissionTotal: string;
  readonly commissionEach: readonly string[];
  readonly beneficiary: string;
  readonly retained: string;
  readonly errors: string;
  readonly held: string;
}
type Shows = (text: string) => boolean;
/** A statistic: its name, its label, its own value, and the values it must not show. */
type Check = readonly [string, RegExp, Shows, readonly Shows[]];

/**
 * Each statistic shows its own value in the item its label opens (anywhere on the page: a detail
 * page, a drawer or a dialog), and not the value of another amount; every value differs, so two
 * swapped statistics fail.
 */
function assertStats(stats: Stats): void {
  const commission = (text: string): boolean =>
    showsYuan(text, stats.commissionTotal) ||
    stats.commissionEach.every((yuan) => showsYuan(text, yuan));
  const anyCommission = (text: string): boolean =>
    [stats.commissionTotal, ...stats.commissionEach].some((yuan) => showsYuan(text, yuan));
  const beneficiary = (text: string): boolean => showsYuan(text, stats.beneficiary);
  const retained = (text: string): boolean => showsYuan(text, stats.retained);
  const orders = (text: string): boolean =>
    showsCount(text, stats.countTotal) || stats.countEach.every((n) => showsCount(text, n));
  const errors = (text: string): boolean => showsCount(text, stats.errors);
  const held = (text: string): boolean => showsCount(text, stats.held);
  const checks: readonly Check[] = [
    ['子订单数', STAT.orders, orders, [anyCommission, beneficiary, retained]],
    ['联盟结算佣金', STAT.commission, commission, [beneficiary, retained]],
    ['受益人份额', STAT.beneficiary, beneficiary, [anyCommission, retained]],
    ['平台留存', STAT.retained, retained, [anyCommission, beneficiary]],
    ['差错单', STAT.errors, errors, [held, anyCommission, beneficiary, retained]],
    ['暂缓', STAT.held, held, [errors, anyCommission, beneficiary, retained]],
  ];
  for (const [name, label, shows, others] of checks) {
    const items = labelledTexts(document.body, label);
    expect(items.length, `an item labelled ${name}`).toBeGreaterThan(0);
    expect(
      items.some((text) => shows(text) && others.every((other) => !other(text))),
      `${name} shows its own value (items: ${items.join(' | ')})`,
    ).toBe(true);
  }
}

it(
  '[AC-F1-08d-DETAIL#1] 【查看】结算中的账单：读 settle-bills/2026-07，显示账单状态、各统计项的值在其标签项内（子订单数、联盟结算佣金、受益人份额、平台留存按分手算，差错单、暂缓）与两个批次（批次号、平台、类型、子订单数、批次状态与结算方式的字典名、定时时刻、确认人）',
  async () => {
    const server = createServer();
    await mount(server);
    const scope = await openBill(server, BILL.settling, BATCH.partial);
    await settled(server);
    expect(server.billReads(BILL.settling).length).toBeGreaterThan(0);
    expect(showsName(textOf(scope), 'billStatus', 'settling'), 'bill status').toBe(true);
    // Bill-day totals: taobao 980 + jd 120 sub-orders; 702550 + 88001 = 790551 fen;
    // beneficiary 553386 fen, retained 237165 fen; error_count 0, held_count 1.
    assertStats({
      countTotal: '1100',
      countEach: ['980', '120'],
      commissionTotal: '7905.51',
      commissionEach: ['7025.50', '880.01'],
      beneficiary: '5533.86',
      retained: '2371.65',
      errors: '0',
      held: '1',
    });

    const partialRow = idRow(BATCH.partial);
    const partial = textOf(partialRow);
    expect(partial).toMatch(TAOBAO);
    expect(showsName(cellText(partialRow, BATCH_COLUMN.kind), 'batchKind', 'main'), 'kind').toBe(
      true,
    );
    expect(showsCount(partial, '975'), 'order_count 975').toBe(true);
    expect(
      showsName(cellText(partialRow, BATCH_COLUMN.status), 'batchStatus', 'PARTIAL'),
      'batch status PARTIAL',
    ).toBe(true);
    expect(
      showsName(cellText(partialRow, BATCH_COLUMN.mode), 'settleMode', 'IMMEDIATE'),
      'settle mode IMMEDIATE',
    ).toBe(true);
    expect(cellText(partialRow, BATCH_COLUMN.confirmer), 'confirmed_by').toMatch(
      idToken(CONFIRMER.first),
    );
    expect(partial).not.toMatch(NOT_A_VALUE);

    const scheduledRow = idRow(BATCH.scheduled);
    const scheduled = textOf(scheduledRow);
    expect(scheduled).toMatch(JD);
    expect(showsName(cellText(scheduledRow, BATCH_COLUMN.kind), 'batchKind', 'main')).toBe(true);
    expect(showsCount(scheduled, '118'), 'order_count 118').toBe(true);
    expect(
      showsName(cellText(scheduledRow, BATCH_COLUMN.status), 'batchStatus', 'CONFIRMED'),
      'batch status CONFIRMED',
    ).toBe(true);
    expect(
      showsName(cellText(scheduledRow, BATCH_COLUMN.mode), 'settleMode', 'SCHEDULED'),
      'settle mode SCHEDULED',
    ).toBe(true);
    expect(squash(scheduled), 'scheduled_at in Beijing time').toContain('2026-08-3110:00');
    expect(cellText(scheduledRow, BATCH_COLUMN.confirmer), 'confirmed_by').toMatch(
      idToken(CONFIRMER.second),
    );
    expect(scheduled).not.toMatch(NOT_A_VALUE);

    for (const id of [BATCH.partial, BATCH.scheduled])
      expect(usable(idRow(id), ITEMS_ENTRY).length, `【明细】 of ${id.slice(0, 8)}`).toBe(1);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-DETAIL#2] 已结算账单的批次表：首批与补充批次都列出，类型与批次状态显示字典名（缺键显示编码）',
  async () => {
    const server = createServer();
    await mount(server);
    const scope = await openBill(server, BILL.settled, BATCH.doneMain);
    await waitFor(() => expect(idRows(BATCH.doneSupplement)).toHaveLength(1));
    expect(showsName(textOf(scope), 'billStatus', 'settled'), 'bill status').toBe(true);
    const firstRow = idRow(BATCH.doneMain);
    const supplementRow = idRow(BATCH.doneSupplement);
    expect(showsName(cellText(firstRow, BATCH_COLUMN.kind), 'batchKind', 'main')).toBe(true);
    expect(showsName(cellText(supplementRow, BATCH_COLUMN.kind), 'batchKind', 'supplement')).toBe(
      true,
    );
    expect(showsName(cellText(supplementRow, BATCH_COLUMN.kind), 'batchKind', 'main')).toBe(false);
    expect(showsCount(textOf(firstRow), '636')).toBe(true);
    expect(showsCount(textOf(supplementRow), '4')).toBe(true);
    for (const row of [firstRow, supplementRow]) {
      expect(textOf(row)).toMatch(TAOBAO);
      expect(showsName(cellText(row, BATCH_COLUMN.status), 'batchStatus', 'DONE')).toBe(true);
    }
    expect(textOf(firstRow)).toMatch(idToken(CONFIRMER.first));
    expect(textOf(supplementRow)).toMatch(idToken(CONFIRMER.second));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-DETAIL#3] 详情地址 settle-bills/2026-08（只持 fund.view）：直接读该账单（页面或抽屉均可），两个待确认批次显示批次状态字典名，各统计项（含差错单 4、暂缓 2）在其标签项内按分换算',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(server, { route: `settle-bills/${BILL.issued}` });
    await waitFor(() => expect(server.billReads(BILL.issued).length).toBeGreaterThan(0));
    await settled(server);
    for (const id of [BATCH.issuedTaobao, BATCH.issuedJd]) {
      await waitFor(() => expect(idRows(id), id.slice(0, 8)).toHaveLength(1));
      expect(showsName(cellText(idRow(id), BATCH_COLUMN.status), 'batchStatus', 'DRAFT')).toBe(
        true,
      );
    }
    expect(textOf(idRow(BATCH.issuedTaobao))).toMatch(TAOBAO);
    expect(textOf(idRow(BATCH.issuedJd))).toMatch(JD);
    const scope = detailScope(idToken(BATCH.issuedTaobao));
    expect(showsName(textOf(scope), 'billStatus', 'issued'), 'bill status').toBe(true);
    // taobao 1200 + jd 300; 864012 + 151005 = 1015017 fen; 712034 and 302983 fen.
    assertStats({
      countTotal: '1500',
      countEach: ['1200', '300'],
      commissionTotal: '10150.17',
      commissionEach: ['8640.12', '1510.05'],
      beneficiary: '7120.34',
      retained: '3029.83',
      errors: '4',
      held: '2',
    });
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
