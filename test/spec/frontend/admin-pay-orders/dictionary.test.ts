// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ANOMALY_TRADE_NO, OUT_TRADE_NO, PERIOD, createServer } from './fixtures.ts';
import {
  ANOMALY_COLUMN,
  DIFF_COLUMN,
  FLOW_TIMEOUT,
  NOT_A_VALUE,
  ORDER_COLUMN,
  TAB,
  cellText,
  dayRow,
  dayRows,
  listed,
  mount,
  openTab,
  rowOf,
  squash,
  textOf,
  token,
} from './helpers.ts';

// The console dictionary without any key: every name falls back to its code.
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
  '[AC-F1-13a-DICT#1] 后台字典缺键时支付单状态与渠道、异常收款渠道、差错类型与状态显示原编码（如 PAID / alipay / pay_mismatch / open），不显示字典名、undefined、空白或键路径',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(OUT_TRADE_NO.paid);
    for (const [number, status, channel] of [
      [OUT_TRADE_NO.manual, 'PENDING', 'wechat_pay'],
      [OUT_TRADE_NO.refunded, 'PAID', 'alipay'],
      [OUT_TRADE_NO.closed, 'CLOSED', 'wechat_pay'],
    ] as const) {
      const row = rowOf(number);
      expect(cellText(row, ORDER_COLUMN.status), number).toMatch(token(status));
      expect(cellText(row, ORDER_COLUMN.channel), number).toMatch(token(channel));
      expect(textOf(row), number).not.toMatch(NOT_A_VALUE);
    }
    const orderNames = [
      ...realNames('admin_dict.pay_order_status.'),
      ...realNames('admin_dict.pay_channel.'),
    ];
    expect(orderNames.length, 'real dictionary rows').toBeGreaterThan(0);
    for (const number of [OUT_TRADE_NO.manual, OUT_TRADE_NO.refunded, OUT_TRADE_NO.closed]) {
      const text = squash(textOf(rowOf(number)));
      for (const name of orderNames) expect(text, `${number} ${name}`).not.toContain(name);
    }

    await openTab(TAB.anomalies);
    await listed(ANOMALY_TRADE_NO.unknownOrder);
    const anomaly = rowOf(ANOMALY_TRADE_NO.unknownOrder);
    expect(cellText(anomaly, ANOMALY_COLUMN.channel)).toMatch(token('alipay'));
    expect(cellText(anomaly, ANOMALY_COLUMN.status)).toMatch(token('open'));
    expect(textOf(anomaly)).not.toMatch(NOT_A_VALUE);

    await openTab(TAB.recon);
    await waitFor(() => expect(dayRows(PERIOD.anomaly)).toHaveLength(1));
    const mismatch = dayRow(PERIOD.mismatch);
    const anomalyDiff = dayRow(PERIOD.anomaly);
    expect(cellText(mismatch, DIFF_COLUMN.type)).toMatch(token('pay_mismatch'));
    expect(cellText(mismatch, DIFF_COLUMN.status)).toMatch(token('open'));
    expect(cellText(anomalyDiff, DIFF_COLUMN.type)).toMatch(token('pay_anomaly'));
    expect(cellText(anomalyDiff, DIFF_COLUMN.status)).toMatch(token('processing'));
    const diffNames = [
      ...realNames('admin_dict.recon_diff_type.pay_'),
      ...realNames('admin_dict.recon_diff_status.'),
    ];
    expect(diffNames.length, 'real dictionary rows').toBeGreaterThan(0);
    for (const row of [mismatch, anomalyDiff]) {
      const text = textOf(row);
      expect(text).not.toMatch(NOT_A_VALUE);
      for (const name of diffNames) expect(squash(text), name).not.toContain(squash(name));
    }
  },
  FLOW_TIMEOUT,
);
