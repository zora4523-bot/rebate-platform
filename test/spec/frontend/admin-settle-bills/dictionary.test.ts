// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { BATCH, BATCH_STATUS_NAME, BILL, SETTLE_MODE_NAME, createServer } from './fixtures.ts';
import {
  COLUMN,
  FLOW_TIMEOUT,
  NOT_A_VALUE,
  billRow,
  cellText,
  idRow,
  listed,
  mount,
  openBill,
  squash,
  textOf,
  token,
} from './helpers.ts';

// The console dictionary without any key (as in [AC-F1-08e-DICT#1]): every name falls back to
// its code.
vi.mock('../../../../contracts/texts.admin.default.json', () => ({ default: { texts: {} } }));

it(
  '[AC-F1-08d-DICT#1] 后台字典缺键时账单状态、批次状态与结算方式显示原编码（如 settling / PARTIAL / SCHEDULED），不显示 undefined、空白或键路径',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(BILL.settling);
    for (const [month, code] of [
      [BILL.issued, 'issued'],
      [BILL.settling, 'settling'],
      [BILL.settled, 'settled'],
    ] as const) {
      expect(squash(cellText(billRow(month), COLUMN.status)), month).toContain(code);
      expect(textOf(billRow(month)), month).not.toMatch(NOT_A_VALUE);
    }
    await openBill(server, BILL.settling, BATCH.partial);
    const partial = textOf(idRow(BATCH.partial));
    const scheduled = textOf(idRow(BATCH.scheduled));
    expect(partial).toMatch(token('PARTIAL'));
    expect(partial).toMatch(token('IMMEDIATE'));
    expect(scheduled).toMatch(token('CONFIRMED'));
    expect(scheduled).toMatch(token('SCHEDULED'));
    for (const row of [partial, scheduled]) {
      expect(row).not.toMatch(NOT_A_VALUE);
      expect(row).not.toContain(BATCH_STATUS_NAME.PARTIAL);
      expect(row).not.toContain(SETTLE_MODE_NAME.SCHEDULED);
    }
  },
  FLOW_TIMEOUT,
);
