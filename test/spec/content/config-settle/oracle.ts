// F1-02zj task §9.1–9.3; BR-FUND-04 at SPEC_REF 5ecafb3.
// This oracle is independent of the implementation registry and seed SQL.
export interface SettleSpec {
  readonly key: string;
  readonly valueType: 'number' | 'enum';
  readonly options: readonly string[] | null;
  readonly permission: 'config.business';
  readonly adminEditable: true;
  readonly range?: { readonly integer: true; readonly min: number; readonly max: number };
}

function number(key: string, min: number, max = 2147483647): SettleSpec {
  return {
    key,
    valueType: 'number',
    options: null,
    permission: 'config.business',
    adminEditable: true,
    range: { integer: true, min, max },
  };
}

function enumeration(key: string, options: readonly string[]): SettleSpec {
  return { key, valueType: 'enum', options, permission: 'config.business', adminEditable: true };
}

export const SETTLE: readonly SettleSpec[] = [
  number('settle.bill_day', 22, 28),
  enumeration('settle.period_basis.taobao', ['received_at']),
  enumeration('settle.period_basis.jd', ['received_at']),
  enumeration('settle.period_basis.pdd', ['received_at']),
  enumeration('settle.period_basis.meituan', ['received_at']),
  enumeration('settle.statement_source.taobao', ['api', 'upload']),
  enumeration('settle.statement_source.jd', ['api', 'upload']),
  enumeration('settle.statement_source.pdd', ['api', 'upload']),
  enumeration('settle.statement_source.meituan', ['api', 'upload']),
  number('settle.batch.match_tolerance_fen', 0),
  number('settle.batch.max_orders', 1),
  number('settle.period_offset_months.taobao', 0),
  number('settle.period_offset_months.jd', 0),
  number('settle.period_offset_months.pdd', 0),
  number('settle.period_offset_months.meituan', 0),
  number('settle.statement.grace_days', 0),
];

export const DEFAULTS = [
  ['settle.bill_day', 24],
  ['settle.period_basis.taobao', 'received_at'],
  ['settle.period_basis.jd', 'received_at'],
  ['settle.period_basis.pdd', 'received_at'],
  ['settle.period_basis.meituan', 'received_at'],
  ['settle.statement_source.taobao', 'api'],
  ['settle.statement_source.jd', 'api'],
  ['settle.statement_source.pdd', 'api'],
  ['settle.statement_source.meituan', 'api'],
  ['settle.batch.match_tolerance_fen', 0],
  ['settle.batch.max_orders', 5000],
  ['settle.period_offset_months.taobao', 1],
  ['settle.period_offset_months.jd', 1],
  ['settle.period_offset_months.pdd', 1],
  ['settle.period_offset_months.meituan', 1],
  ['settle.statement.grace_days', 10],
] as const;
