import { expect, it } from 'vitest';
import { configItemSpecOf, configRegistry, configValueFits } from './config-registry.ts';

const SETTLE_KEYS = [
  'settle.bill_day',
  'settle.period_basis.taobao',
  'settle.period_basis.jd',
  'settle.period_basis.pdd',
  'settle.period_basis.meituan',
  'settle.statement_source.taobao',
  'settle.statement_source.jd',
  'settle.statement_source.pdd',
  'settle.statement_source.meituan',
  'settle.batch.match_tolerance_fen',
  'settle.batch.max_orders',
  'settle.period_offset_months.taobao',
  'settle.period_offset_months.jd',
  'settle.period_offset_months.pdd',
  'settle.period_offset_months.meituan',
  'settle.statement.grace_days',
];

function spec(key: string) {
  const found = configItemSpecOf(key);
  expect(found, key).not.toBeNull();
  return found!;
}

it('[AC-F1-02zj#2] settle.* items are appended after the 29 earlier items, editable config.business', () => {
  const registry = configRegistry();
  expect(registry).toHaveLength(45);
  expect(registry[28]!.key).toBe('external_hosts');
  expect(registry.slice(29).map((entry) => entry.key)).toStrictEqual(SETTLE_KEYS);
  for (const entry of registry.slice(29)) {
    expect(entry.permission).toBe('config.business');
    expect(entry.adminEditable).toBe(true);
  }
  for (const entry of registry.slice(0, 29)) expect('range' in entry, entry.key).toBe(false);
});

it('[AC-F1-02zj#4] settle.bill_day accepts integers 22..28 only', () => {
  const billDay = spec('settle.bill_day');
  for (const value of [22, 24, 28]) expect(configValueFits(billDay, value)).toBe(true);
  for (const value of [21, 29, 24.5, '24', null, Number.NaN]) {
    expect(configValueFits(billDay, value)).toBe(false);
  }
});

it('[AC-F1-02zj#4] lower-bounded settle.* integers stop at the int4 maximum', () => {
  const maxOrders = spec('settle.batch.max_orders');
  expect(configValueFits(maxOrders, 0)).toBe(false);
  expect(configValueFits(maxOrders, 1)).toBe(true);
  expect(configValueFits(maxOrders, 2147483647)).toBe(true);
  expect(configValueFits(maxOrders, 2147483648)).toBe(false);
  const tolerance = spec('settle.batch.match_tolerance_fen');
  expect(configValueFits(tolerance, 0)).toBe(true);
  expect(configValueFits(tolerance, -1)).toBe(false);
  expect(configValueFits(tolerance, 0.5)).toBe(false);
  expect(configValueFits(spec('settle.period_offset_months.pdd'), -1)).toBe(false);
  expect(configValueFits(spec('settle.statement.grace_days'), 0)).toBe(true);
});

it('[AC-F1-02zj#5] settle.* enum items accept their exact options only', () => {
  const basis = spec('settle.period_basis.jd');
  expect(basis.options).toStrictEqual(['received_at']);
  expect(configValueFits(basis, 'received_at')).toBe(true);
  expect(configValueFits(basis, 'settled_at')).toBe(false);
  const source = spec('settle.statement_source.meituan');
  expect(configValueFits(source, 'api')).toBe(true);
  expect(configValueFits(source, 'upload')).toBe(true);
  expect(configValueFits(source, 'API')).toBe(false);
  expect(configValueFits(source, '')).toBe(false);
});

it('[AC-F1-02zj#6] lookups are literal: no pattern, suffix-less or removed keys', () => {
  for (const key of [
    'settle.period_basis',
    'settle.period_basis.vip',
    'settle.period_basis.TAOBAO',
    'settle.bill_day.taobao',
    'settle.wait_days.taobao',
  ]) {
    expect(configItemSpecOf(key), key).toBeNull();
  }
});

it('[AC-F1-02zj#2] number items without a range keep the finite-number check', () => {
  const sample = spec('external_page.nav_host_sample_bp');
  for (const value of [-1, 0.5, 2147483648]) expect(configValueFits(sample, value)).toBe(true);
  expect(configValueFits(sample, Number.POSITIVE_INFINITY)).toBe(false);
});
