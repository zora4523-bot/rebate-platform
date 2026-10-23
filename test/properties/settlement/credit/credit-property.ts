// PG property body of B2-04m (single-order credit, R5). The discoverable *.int.test.ts entry lives
// in test/spec/settlement/credit: the integration config only includes spec/**/*.int.test.ts.
//
// Oracle written from the rules, not from the planner: B = floor(max(0,N) × (10000 − reserve_bp) /
// 10000) (BR-CALC-02, tlj 0); share = floor(B × ratio / 10000) (BR-CALC-04); per beneficiary state
// after the locks (BR-CALC-13): normal / deletion cooling-off / self minor → CREDIT, frozen /
// appealing → held
// (first_credit obligation when > 0), banned / deleting / promotional minor → FORFEIT; platform =
// B − Σ shares + reserve (BR-FUND-05); UNION_RECEIVABLE = max(0,N) − Σ held (BR-FUND-19 ⑤).
import { addFen, subFen } from '@couli/money';
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect } from 'vitest';
import {
  baseOf,
  creditKey,
  forfeitKey,
  platformKey,
  receivable,
  shareOf,
  type Harness,
  type PersonSpec,
  type UserState,
} from '../../../spec/settlement/credit/kit.ts';

/** DB-backed runs: PROP_RUNS scaled by 1/100, at least 20 (each run seeds and credits one order). */
export function creditRuns(): number {
  return Math.max(20, Math.floor(propRuns() / 100));
}

const STATES: readonly UserState[] = [
  'normal',
  'frozen',
  'appealing',
  'banned',
  'deleting',
  'minor',
  // Deletion cooling-off is not a loss (BR-CALC-13): credited like normal.
  'cooling',
];

const person = (role: 'self' | 'direct' | 'indirect', maxBp: number) =>
  fc.record({
    role: fc.constant(role),
    ratioBp: fc.integer({ min: 0, max: maxBp }),
    state: fc.constantFrom(...STATES),
  });

const scenario = fc.record({
  n: fc.oneof(
    fc.bigInt({ min: -500n, max: 0n }),
    fc.bigInt({ min: 1n, max: 999n }),
    fc.bigInt({ min: 1000n, max: 5_000_000n }),
    // Beyond int4 / int32 (2^31) and 2^32, so a narrowed column or number path shows up.
    fc.bigInt({ min: 2_147_483_648n, max: 100_000_000_000_000n }),
  ),
  reserveBp: fc.oneof(fc.constantFrom(0, 1500, 10000), fc.integer({ min: 0, max: 10000 })),
  self: person('self', 8000),
  direct: fc.option(person('direct', 1500), { nil: null }),
  indirect: fc.option(person('indirect', 500), { nil: null }),
});

type Verdict = 'credit' | 'held' | 'forfeit';

function verdictOf(state: UserState, role: 'self' | 'direct' | 'indirect'): Verdict {
  if (state === 'frozen' || state === 'appealing') return 'held';
  if (state === 'banned' || state === 'deleting') return 'forfeit';
  if (state === 'minor' && role !== 'self') return 'forfeit';
  return 'credit';
}

/** Runs the property; returns the number of checked scenarios. */
export async function assertCreditProperty(h: Harness): Promise<number> {
  // Seed one order and build the service before the property, so a broken harness or a missing
  // implementation shows up once, outside fast-check.
  const warmup = await h.order();
  h.boot();
  expect(await h.credit(warmup)).toMatchObject({ outcome: 'credited' });

  let checked = 0;
  await fc.assert(
    fc.asyncProperty(scenario, async (s) => {
      const specs: PersonSpec[] = [s.self, s.direct, s.indirect].flatMap((p) =>
        p === null ? [] : [{ role: p.role, ratioBp: p.ratioBp, state: p.state }],
      );
      const o = await h.order({ people: specs, settleFen: s.n, reserveBp: s.reserveBp });
      const positive = s.n > 0n ? s.n : 0n;
      const { base, reserve } = baseOf(s.n, s.reserveBp);

      const result = await h.credit(o);
      expect(result).toMatchObject({
        outcome: 'credited',
        bCreditFen: base,
        bookedNFen: positive,
      });

      const expectedKeys: string[] = [];
      let assigned = 0n;
      let held = 0n;
      let forfeited = 0n;
      let heldWithShare = 0;
      for (const spec of specs) {
        const share = shareOf(base, spec.ratioBp);
        assigned = addFen(assigned, share);
        const role = spec.role as 'self' | 'direct' | 'indirect';
        const verdict = verdictOf(spec.state ?? 'normal', role);
        const userId = o.user(spec.role);
        if (verdict === 'credit') {
          expect(await h.balance(userId)).toBe(share);
          if (share > 0n) {
            expectedKeys.push(creditKey(o, spec.role));
            expect(await h.voucherLines(creditKey(o, spec.role))).toEqual(
              [
                `${receivable(o)}|platform|${String(share)}`,
                `USER_BALANCE|${userId}|${String(-share)}`,
              ].sort(),
            );
          }
        } else if (verdict === 'held') {
          expect(await h.balance(userId)).toBe(0n);
          held = addFen(held, share);
          if (share > 0n) heldWithShare += 1;
        } else {
          expect(await h.balance(userId)).toBe(0n);
          forfeited = addFen(forfeited, share);
          if (share > 0n) {
            expectedKeys.push(forfeitKey(o, spec.role));
            expect(await h.voucherLines(forfeitKey(o, spec.role))).toEqual(
              [
                `${receivable(o)}|platform|${String(share)}`,
                `COMMISSION_REVENUE|platform|${String(-share)}`,
              ].sort(),
            );
          }
        }
      }
      const platformCredit = addFen(subFen(base, assigned), reserve);
      if (platformCredit > 0n) expectedKeys.push(platformKey(o));
      expect(result).toMatchObject({ platformCreditFen: platformCredit });

      const ofOrder = (key: string) => key.startsWith(`${o.orderKey}:`);
      const mine = (await h.vouchers()).filter((v) => ofOrder(v.uniq_key));
      expect(mine.map((v) => v.uniq_key).sort()).toEqual(expectedKeys.sort());
      // BR-FUND-05 voucher kinds: user and platform CREDIT, forfeited shares FORFEIT.
      for (const v of mine) {
        expect(v.voucher_kind, v.uniq_key).toBe(
          v.uniq_key.includes(':PLATFORM:FORFEIT:') ? 'FORFEIT' : 'CREDIT',
        );
      }
      const lines = (await h.lines()).filter((l) => ofOrder(l.uniq_key));
      for (const key of expectedKeys) {
        const own = lines.filter((l) => l.uniq_key === key);
        expect(own.length).toBeGreaterThanOrEqual(2);
        expect(own.reduce((sum, l) => addFen(sum, l.amount_fen), 0n)).toBe(0n);
      }
      const net = (subject: string) =>
        lines
          .filter((l) => l.subject === subject)
          .reduce((sum, l) => addFen(sum, l.amount_fen), 0n);
      expect(net(receivable(o))).toBe(subFen(positive, held));
      expect(net('COMMISSION_REVENUE')).toBe(subFen(0n, addFen(platformCredit, forfeited)));

      const obligations = (await h.obligations()).filter((row) => row.order_id === o.orderId);
      expect(obligations).toHaveLength(heldWithShare);
      for (const row of obligations) {
        expect(row).toMatchObject({ kind: 'first_credit', opened_by: 'R5', status: 'open' });
      }
      expect(await h.read(o)).toMatchObject({
        rebate_status: 'CREDITED',
        booked_base_fen: base,
        booked_n_fen: positive,
      });

      // Replay of the same order: skipped, nothing more written for it.
      const vouchersBefore = mine.length;
      expect(await h.credit(o)).toEqual({ outcome: 'skipped', reason: 'not_waiting' });
      expect((await h.vouchers()).filter((v) => ofOrder(v.uniq_key))).toHaveLength(vouchersBefore);
      checked += 1;
    }),
    { numRuns: creditRuns(), seed: propSeed() },
  );
  return checked;
}
