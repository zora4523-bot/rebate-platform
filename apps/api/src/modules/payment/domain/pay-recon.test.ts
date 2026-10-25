// B2-15j unit tests of the pure part of the T+1 reconciliation (domain/pay-recon.ts; 08 BR-PAY-07).
import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  billFeeTotal,
  nextBillReconRun,
  parseBillRows,
  pickLines,
  previousBillDate,
  type PayBillRow,
} from './pay-recon.ts';

function trade(patch: Partial<PayBillRow> = {}): PayBillRow {
  return {
    record_type: 'trade',
    out_trade_no: 'P0001',
    channel_trade_no: 'T0001',
    out_refund_no: '',
    channel_refund_no: '',
    amount_fen: '12345',
    state: 'SUCCESS',
    fee_fen: '74',
    ...patch,
  };
}

function refund(patch: Partial<PayBillRow> = {}): PayBillRow {
  return trade({
    record_type: 'refund',
    out_refund_no: 'R0001',
    channel_refund_no: 'CR0001',
    amount_fen: '1000',
    fee_fen: '-2',
    ...patch,
  });
}

describe('parseBillRows', () => {
  it('[AC-B2-15j#u1] well-formed trade and refund rows become lines with bigint fen', () => {
    const parsed = parseBillRows([trade(), refund()]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.lines.map((l) => [l.kind, l.amountFen, l.feeFen])).toEqual([
      ['trade', 12345n, 74n],
      ['refund', 1000n, -2n],
    ]);
  });

  it('[AC-B2-15j#u2] one unreadable row refuses the whole bill, naming the row and the field', () => {
    const cases: [PayBillRow, string][] = [
      [trade({ amount_fen: '12.30' }), 'amount_fen'],
      [trade({ amount_fen: '0' }), 'amount_fen'],
      [trade({ amount_fen: '-5' }), 'amount_fen'],
      [trade({ fee_fen: '1e2' }), 'fee_fen'],
      [trade({ out_trade_no: '' }), 'trade_numbers'],
      [trade({ channel_trade_no: '' }), 'trade_numbers'],
      [refund({ out_refund_no: '' }), 'out_refund_no'],
      [trade({ state: '' }), 'state'],
      [{ ...trade(), record_type: 'other' } as unknown as PayBillRow, 'record_type'],
    ];
    for (const [row, reason] of cases) {
      expect(parseBillRows([trade(), row])).toEqual({ ok: false, index: 1, reason });
    }
  });
});

describe('pickLines and billFeeTotal', () => {
  it('[AC-B2-15j#u3] one line per number, a listed state winning; fees summed over every line', () => {
    const parsed = parseBillRows([
      trade({ state: 'CLOSED', channel_trade_no: 'T-closed' }),
      trade({ channel_trade_no: 'T-paid' }),
      trade({ out_trade_no: 'P0002', state: 'NOTPAY' }),
      refund(),
    ]);
    if (!parsed.ok) throw new Error('fixture bill must parse');
    const trades = pickLines(parsed.lines, 'trade', ['SUCCESS']);
    expect([...trades.keys()]).toEqual(['P0001', 'P0002']);
    expect(trades.get('P0001')?.channelTradeNo).toBe('T-paid');
    expect(trades.get('P0002')?.state).toBe('NOTPAY');
    expect([...pickLines(parsed.lines, 'refund', ['SUCCESS']).keys()]).toEqual(['R0001']);
    expect(billFeeTotal(parsed.lines)).toBe(74n * 3n - 2n);
  });
});

describe('bill days at +08:00', () => {
  it('[AC-B2-15j#u4] a run reconciles the accounting day before it, whatever the UTC date', () => {
    expect(previousBillDate(new FixedClock('2026-10-22T02:00:00.000Z').now())).toBe('2026-10-21');
    expect(previousBillDate(new FixedClock('2026-10-21T17:00:00.000Z').now())).toBe('2026-10-21');
    expect(previousBillDate(new FixedClock('2026-10-21T15:59:59.000Z').now())).toBe('2026-10-20');
  });

  it('[AC-B2-15j#u5] the next run is 10:00 +08:00 of the next accounting day and reconciles today', () => {
    const next = nextBillReconRun(new FixedClock('2026-10-22T02:00:00.000Z').now());
    expect(next.billDate).toBe('2026-10-22');
    expect(next.at.toISOString()).toBe('2026-10-23T02:00:00.000Z');
    const early = nextBillReconRun(new FixedClock('2026-10-21T17:00:00.000Z').now());
    expect(early.billDate).toBe('2026-10-22');
    expect(early.at.toISOString()).toBe('2026-10-23T02:00:00.000Z');
  });
});
