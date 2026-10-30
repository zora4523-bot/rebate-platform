// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { BATCH, BILL, ORDER, createServer } from './fixtures.ts';
import {
  BATCH_COLUMN,
  COLUMN,
  FLOW_TIMEOUT,
  ITEM_COLUMN,
  NOT_A_VALUE,
  billRow,
  cellText,
  idRow,
  idRows,
  listed,
  mount,
  openBill,
  openItems,
  squash,
  textOf,
  token,
} from './helpers.ts';

// The console dictionary without any key (as in [AC-F1-08e-DICT#1]): every name falls back to
// its code.
vi.mock('../../../../contracts/texts.admin.default.json', () => ({ default: { texts: {} } }));

/** The names of the real dictionary file (read from disk, past the mock) under `prefix`. */
function realNames(prefix: string): string[] {
  const file = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../contracts/texts.admin.default.json',
  );
  const real = JSON.parse(readFileSync(file, 'utf8')) as { texts?: Record<string, string> };
  return Object.entries(real.texts ?? {}).flatMap(([name, value]) =>
    name.startsWith(prefix) ? [value] : [],
  );
}

it(
  '[AC-F1-08d-DICT#1] 后台字典缺键时账单状态、批次状态、结算方式、批次类型、明细类型与结果显示原编码（如 settling / PARTIAL / SCHEDULED / main / order / credited），不显示 undefined、空白或键路径',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(BILL.settling);
    for (const [month, code] of [
      [BILL.issued, 'issued'],
      [BILL.settling, 'settling'],
      [BILL.settled, 'settled'],
    ] as const) {
      expect(cellText(billRow(month), COLUMN.status), month).toMatch(token(code));
      expect(textOf(billRow(month)), month).not.toMatch(NOT_A_VALUE);
    }
    await openBill(server, BILL.settling, BATCH.partial);
    const partialRow = idRow(BATCH.partial);
    const scheduledRow = idRow(BATCH.scheduled);
    expect(cellText(partialRow, BATCH_COLUMN.status)).toMatch(token('PARTIAL'));
    expect(cellText(partialRow, BATCH_COLUMN.mode)).toMatch(token('IMMEDIATE'));
    expect(cellText(partialRow, BATCH_COLUMN.kind)).toMatch(token('main'));
    expect(cellText(scheduledRow, BATCH_COLUMN.status)).toMatch(token('CONFIRMED'));
    expect(cellText(scheduledRow, BATCH_COLUMN.mode)).toMatch(token('SCHEDULED'));
    // Names of the real dictionary must not show while it is empty.
    const names = [
      ...realNames('admin_dict.settle_batch.'),
      ...realNames('admin_dict.settle_mode.'),
    ];
    expect(names.length, 'real dictionary rows').toBeGreaterThan(0);
    for (const row of [partialRow, scheduledRow]) {
      const text = textOf(row);
      expect(text).not.toMatch(NOT_A_VALUE);
      for (const name of names) expect(squash(text), name).not.toContain(name);
    }

    await openItems(server, BATCH.partial);
    await waitFor(() => expect(idRows(ORDER.credited)).toHaveLength(1));
    const credited = idRow(ORDER.credited);
    const beneficiary = idRow(ORDER.beneficiary);
    expect(cellText(credited, ITEM_COLUMN.type)).toMatch(token('order'));
    expect(cellText(credited, ITEM_COLUMN.result)).toMatch(token('credited'));
    expect(cellText(beneficiary, ITEM_COLUMN.type)).toMatch(token('beneficiary'));
    for (const row of [credited, beneficiary]) expect(textOf(row)).not.toMatch(NOT_A_VALUE);
  },
  FLOW_TIMEOUT,
);
