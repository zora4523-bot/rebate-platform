import { expect, it } from 'vitest';
import {
  formatAccountingDate,
  groupByMonth,
  monthTitle,
  shanghaiYear,
  toRow,
  type LedgerEntry,
} from './format.ts';

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ledger_type: 'REBATE_CREDIT',
    sub_type: null,
    amount_fen: 100,
    accounting_date: '2026-10-12',
    link_type: null,
    link_id: null,
    masked: false,
    balance_after_fen: 100,
    ...overrides,
  } as LedgerEntry;
}

it('shanghai year rolls over at 16:00 UTC on 31 December', () => {
  expect(shanghaiYear(Date.parse('2025-12-31T15:59:59Z'))).toBe('2025');
  expect(shanghaiYear(Date.parse('2025-12-31T16:00:00Z'))).toBe('2026');
});

it('accounting dates show MM-DD in the current year and the full date otherwise', () => {
  expect(formatAccountingDate('2026-01-05', '2026')).toBe('01-05');
  expect(formatAccountingDate('2025-12-31', '2026')).toBe('2025-12-31');
  expect(formatAccountingDate('bad', '2026')).toBe('bad');
});

it('month titles drop the leading zero of the month', () => {
  expect(monthTitle('2026-09')).toMatch(/^2026\D+9\D+$/);
});

it('unknown ADMIN_ADJUST reason codes fall back to OTHER and keep the hint', () => {
  const other = toRow(entry({ ledger_type: 'ADMIN_ADJUST', sub_type: 'OTHER' }), '2026');
  const unknown = toRow(entry({ ledger_type: 'ADMIN_ADJUST', sub_type: 'NEW_CODE' }), '2026');
  expect(unknown.name).toBe(other.name);
  expect(unknown.hint).toBe(other.hint);
  expect(unknown.hint).not.toBeNull();
});

it('only order and withdrawal links with an id are navigable', () => {
  expect(toRow(entry({ link_type: 'order', link_id: '' }), '2026').link).toBeNull();
  expect(toRow(entry({ link_type: null, link_id: 'x' }), '2026').link).toBeNull();
  expect(toRow(entry({ link_type: 'withdrawal', link_id: 'w' }), '2026').link).toEqual({
    route: 'WithdrawRecords',
    params: { withdrawal_id: 'w' },
  });
});

it('a zero amount has no sign and a non-rebate credit gets no accent', () => {
  const row = toRow(entry({ ledger_type: 'WITHDRAW_RETURN', amount_fen: 0 }), '2026');
  expect(row.amount).toBe('¥0');
  expect(row.accent).toBe(false);
  expect(toRow(entry(), '2026').accent).toBe(true);
});

it('groups keep server order, skip closed-account entries and give unique keys', () => {
  const now = Date.parse('2026-10-22T04:00:00Z');
  const groups = groupByMonth(
    [
      entry({ accounting_date: '2026-10-02' }),
      entry({ ledger_type: 'ADMIN_ADJUST', sub_type: 'ACCOUNT_CLOSED' }),
      entry({ accounting_date: '2026-09-30' }),
      entry({ accounting_date: '2026-09-01' }),
    ],
    now,
  );
  expect(groups.map((group) => [group.month, group.rows.length])).toEqual([
    ['2026-10', 1],
    ['2026-09', 2],
  ]);
  expect(new Set(groups.map((group) => group.key)).size).toBe(2);
});
