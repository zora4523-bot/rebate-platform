import { expect, it } from 'vitest';
import { aggregateOrderFigures, type OrderFiguresEntryRow } from './order-figures-read.ts';

const EARLY = new Date('2027-12-05T02:00:00.000Z');
const LATE = new Date('2027-12-09T02:00:00.000Z');

function row(
  order_key: string | null,
  voucher_kind: string | null,
  amount_fen: bigint,
  booked_at: Date = EARLY,
): OrderFiguresEntryRow {
  return { order_key, voucher_kind, amount_fen, booked_at };
}

it('[AC-B1-09p#U1] 入账、补差按用户侧符号，扣回取绝对值，最近一次扣回与读入顺序无关', () => {
  const entries = aggregateOrderFigures([
    row('jd:1', 'CREDIT', -425n),
    row('jd:1', 'SETTLE_ADJUST', -17n),
    row('jd:1', 'SETTLE_ADJUST', 10n),
    row('jd:1', 'CLAWBACK', 100n, LATE),
    row('jd:1', 'CLAWBACK', 50n, EARLY),
  ]);
  expect(entries.get('jd:1')).toEqual({
    credited_fen: 425n,
    settle_adjust_fen: 7n,
    clawback_fen: 150n,
    last_clawback_at: LATE,
  });
});

it('[AC-B1-09p#U2] 按 order_key 分开，没有键的行与公式之外的凭证不计入', () => {
  const entries = aggregateOrderFigures([
    row('jd:1', 'CREDIT', -425n),
    row('pdd:1', 'CREDIT', -300n),
    row(null, 'CREDIT', -1n),
    row('jd:1', 'REASSIGN_REV', 425n),
    row('jd:1', null, 5n),
  ]);
  expect([...entries.keys()]).toEqual(['jd:1', 'pdd:1']);
  expect(entries.get('jd:1')?.credited_fen).toBe(425n);
  expect(entries.get('pdd:1')?.credited_fen).toBe(300n);
});
