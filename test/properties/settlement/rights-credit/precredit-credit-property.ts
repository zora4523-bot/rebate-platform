// PG property body of B2-04lb ① (D10-463): a partial rights success before credit (应扣佣金 d on a
// WAITING order whose effective union commission is the settlement N) makes the later credit (R5)
// book N_new = N − d. The discoverable *.int.test.ts entry lives in test/spec/settlement/rights-credit
// (the integration config only includes spec/**/*.int.test.ts).
//
// Oracle written from the rules, not from the planner: N_new = N − d (BR-FUND-06 / BR-FUND-08 ②);
// B = floor(N_new × (10000 − reserve_bp) / 10000) (BR-CALC-02, tlj 0); share = floor(B × ratio /
// 10000) (BR-CALC-04); all beneficiaries normal, so each balance = its share and the order's
// UNION_RECEIVABLE net = N_new (BR-FUND-05); booked pair = (B, N_new). The generator keeps N_new ≥ 10
// and reserve_bp ≤ 9000, so B ≥ 1 (the partial side, R7; never BASE_ZERO).
import { addFen, subFen } from '@couli/money';
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect } from 'vitest';
import { baseOf, shareOf } from '../../../spec/settlement/credit/kit.ts';
import { receivable, type Harness } from '../../../spec/settlement/rights-credit/kit.ts';

/** DB-backed runs: PROP_RUNS scaled by 1/100, at least 20 (each run seeds and credits one order). */
export function rightsCreditRuns(): number {
  return Math.max(20, Math.floor(propRuns() / 100));
}

const fen = (min: bigint, max: bigint) => fc.bigInt({ min, max });

const scenario = fc.record({
  nNew: fc.oneof(
    fen(10n, 999n),
    fen(1000n, 5_000_000n),
    // Beyond int4 / int32 (2^31) and 2^32, so a narrowed column or number path shows up.
    fen(2_147_483_648n, 100_000_000_000_000n),
  ),
  deduction: fc.oneof(fen(1n, 999n), fen(1000n, 100_000_000_000_000n)),
  reserveBp: fc.oneof(fc.constantFrom(0, 1500, 9000), fc.integer({ min: 0, max: 9000 })),
  selfBp: fc.integer({ min: 0, max: 8000 }),
  directBp: fc.integer({ min: 0, max: 1500 }),
  indirectBp: fc.integer({ min: 0, max: 500 }),
});

/** Runs the property; returns the number of checked scenarios. */
export async function assertPrecreditRightsCreditProperty(h: Harness): Promise<number> {
  // One fixed case outside fast-check, so a missing implementation shows up once with a plain
  // assertion: N 1000, d 400 → N_new 600, B 510 (not 850).
  const warmup = await h.order();
  h.estimateBases.mockResolvedValueOnce({ before: 850n, after: 510n });
  expect(await h.record(warmup, { deductionFen: 400n })).toEqual({ kind: 'applied' });
  expect(await h.creditAt(warmup)).toMatchObject({
    outcome: 'credited',
    bCreditFen: 510n,
    bookedNFen: 600n,
  });

  let checked = 0;
  await fc.assert(
    fc.asyncProperty(scenario, async (s) => {
      const n = addFen(s.nNew, s.deduction);
      const o = await h.order({
        settleFen: n,
        reserveBp: s.reserveBp,
        people: [
          { role: 'self', ratioBp: s.selfBp },
          { role: 'direct', ratioBp: s.directBp },
          { role: 'indirect', ratioBp: s.indirectBp },
        ],
      });
      const { base, reserve } = baseOf(s.nNew, s.reserveBp);
      // commission's valuation of the effective commission N → N_new (what a real one returns).
      h.estimateBases.mockResolvedValueOnce({ before: baseOf(n, s.reserveBp).base, after: base });
      const recorded = await h.record(o, { deductionFen: s.deduction });
      const result = await h.creditAt(o);

      const shares = {
        self: shareOf(base, s.selfBp),
        direct: shareOf(base, s.directBp),
        indirect: shareOf(base, s.indirectBp),
      };
      const assigned = addFen(addFen(shares.self, shares.direct), shares.indirect);
      const platform = addFen(subFen(base, assigned), reserve);
      let ok =
        recorded.kind === 'applied' &&
        result.outcome === 'credited' &&
        result.bCreditFen === base &&
        result.bookedNFen === s.nNew &&
        result.platformCreditFen === platform;
      for (const role of ['self', 'direct', 'indirect'] as const) {
        ok = ok && (await h.balance(o.user(role))) === shares[role];
      }
      const row = await h.read(o);
      ok =
        ok &&
        row.rebate_status === 'CREDITED' &&
        row.booked_base_fen === base &&
        row.booked_n_fen === s.nNew &&
        (await h.orderSubjectNet(o, receivable(o))) === s.nNew;
      if (ok) checked += 1;
      return ok;
    }),
    { numRuns: rightsCreditRuns(), seed: propSeed() },
  );
  return checked;
}
