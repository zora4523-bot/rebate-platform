import { expect, it } from 'vitest';
import { configCenterTexts as t } from '../../texts/config-center.ts';
import { collectBatch, parseInput, type ConfigRow, type FieldValue } from './model.ts';

function row(key: string, patch: Partial<ConfigRow> = {}): ConfigRow {
  return {
    key,
    value: 500000,
    value_type: 'number',
    options: null,
    permission: 'config.general',
    admin_editable: true,
    version: 3,
    updated_by: null,
    updated_at: null,
    ...patch,
  };
}

const MONEY = row('withdraw.max_amount_fen');

it('[F1-06zg] amounts accept at most two decimals of the typed text and convert to whole fen', () => {
  expect(parseInput(MONEY, '3000')).toEqual({ ok: true, value: 300000 });
  expect(parseInput(MONEY, '3000.50')).toEqual({ ok: true, value: 300050 });
  expect(parseInput(MONEY, '0.29')).toEqual({ ok: true, value: 29 });
  expect(parseInput(MONEY, ' 12.34 ')).toEqual({ ok: true, value: 1234 });
});

it('[F1-06zg] amounts with a third decimal are refused even when it is a trailing zero', () => {
  for (const text of ['12.340', '12.345', '0.001', '1.000'])
    expect(parseInput(MONEY, text)).toEqual({ ok: false, message: t.validation.moneyDecimals });
});

it('[F1-06zg] negative, non-numeric and exponent amounts are refused, never rounded', () => {
  expect(parseInput(MONEY, '-1')).toEqual({ ok: false, message: t.validation.moneyNegative });
  for (const text of ['abc', '1e3', '12.', '.5', '1,000', '0x10'])
    expect(parseInput(MONEY, text)).toEqual({ ok: false, message: t.validation.moneyFormat });
  expect(parseInput(MONEY, '')).toEqual({ ok: false, message: t.validation.required });
  expect(parseInput(MONEY, null)).toEqual({ ok: false, message: t.validation.required });
});

const NEVER_WRITTEN = row('earnings.dashboard.enabled', {
  value: null,
  value_type: 'boolean',
  version: 0,
});
const COUNT = row('favorites.max_per_user', { value: 200 });

function collect(values: Record<string, FieldValue>, touched: readonly string[]) {
  return collectBatch([NEVER_WRITTEN, COUNT], values, (key) => touched.includes(key));
}

it('[F1-06zg] a batch never sends an untouched never-written switch shown off', () => {
  const result = collect({ [NEVER_WRITTEN.key]: false, [COUNT.key]: '300' }, [COUNT.key]);
  expect(result).toEqual({ ok: true, entries: [{ row: COUNT, value: 300 }] });
});

it('[F1-06zg] a batch skips a control turned back to its starting value', () => {
  const result = collect({ [NEVER_WRITTEN.key]: false, [COUNT.key]: '300' }, [
    NEVER_WRITTEN.key,
    COUNT.key,
  ]);
  expect(result).toEqual({ ok: true, entries: [{ row: COUNT, value: 300 }] });
});

it('[F1-06zg] a batch sends a never-written switch the operator turned on', () => {
  const result = collect({ [NEVER_WRITTEN.key]: true, [COUNT.key]: null }, [NEVER_WRITTEN.key]);
  expect(result).toEqual({ ok: true, entries: [{ row: NEVER_WRITTEN, value: true }] });
});

it('[F1-06zg] a batch skips touched values equal to the current value and reports invalid ones', () => {
  expect(collect({ [NEVER_WRITTEN.key]: false, [COUNT.key]: '200' }, [COUNT.key])).toEqual({
    ok: true,
    entries: [],
  });
  expect(collect({ [NEVER_WRITTEN.key]: false, [COUNT.key]: 'x' }, [COUNT.key])).toEqual({
    ok: false,
    key: COUNT.key,
    message: t.validation.number,
  });
});
