// PG property body of B2-04s (post-credit clawback, R8 / R9). The discoverable *.int.test.ts entry
// lives in test/spec/settlement/clawback: the integration config only includes
// spec/**/*.int.test.ts.
//
// Oracle written from the rules, not from the planner:
// - credit (BR-CALC-13): normal / self minor → credited share0; frozen → held (obligation when
//   share0 > 0); banned / deleting / promotional minor → forfeited.
// - after the credit a beneficiary may become banned, deleting or frozen (both orders alike).
// - each step is a partial refund with the union's new commission N_i (strictly decreasing); the
//   first step whose N_i positive part is 0, or whose B_i is 0 while the booked base is > 0, is R8
//   and ends the sequence.
// - BR-CALC-09 full recomputation with B_F = floor(max(0, N_F) × (10000 − reserve_bp) / 10000):
//   R9 → credited: net = share(B_F) (banned / deleting take min(share, net) = share(B_F) too);
//   held and still not lost: net 0, pending = share(B_F); held then banned / deleting: 0 / 0;
//   forfeited at credit: 0. R8 → every net and pending 0.
// - UNION_RECEIVABLE = max(0, N) − Σ pending after every step (BR-FUND-08 / 19 ⑤); platform net =
//   max(0, N) − Σ net − Σ pending; booked pair = (B_F, max(0, N_F)); nets never negative.
// - several adjustments end where one recomputation from the credit ends (BR-CALC-09).
import { addFen, mulDivFloor, subFen } from '@couli/money';
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect } from 'vitest';
import {
  baseOf,
  shareOf,
  type Harness,
  type PersonSpec,
  type SeededOrder,
} from '../../../spec/settlement/clawback/kit.ts';

/** DB-backed runs: PROP_RUNS scaled by 1/100, at least 10 (each run credits two orders). */
export function clawbackRuns(): number {
  return Math.max(10, Math.floor(propRuns() / 100));
}

type Role = 'self' | 'direct' | 'indirect';
type AtCredit = 'normal' | 'frozen' | 'banned' | 'deleting' | 'minor';
type After = 'none' | 'banned' | 'deleting' | 'frozen';

interface Person {
  readonly role: Role;
  readonly ratioBp: number;
  readonly state: AtCredit;
  readonly after: After;
}

const AT_CREDIT: readonly AtCredit[] = ['normal', 'frozen', 'banned', 'deleting', 'minor'];
const AFTER: readonly After[] = ['none', 'banned', 'deleting', 'frozen'];

const person = (role: Role, maxBp: number) =>
  fc.record({
    role: fc.constant(role),
    ratioBp: fc.integer({ min: 0, max: maxBp }),
    state: fc.constantFrom(...AT_CREDIT),
    after: fc.constantFrom(...AFTER),
  });

const scenario = fc.record({
  n0: fc.oneof(
    fc.bigInt({ min: 1n, max: 999n }),
    fc.bigInt({ min: 1000n, max: 5_000_000n }),
    // Beyond int4 / int32 (2^31), so a narrowed column or number path shows up.
    fc.bigInt({ min: 2_147_483_648n, max: 100_000_000_000_000n }),
  ),
  reserveBp: fc.oneof(fc.constantFrom(0, 1500, 10000), fc.integer({ min: 0, max: 10000 })),
  /** Each step keeps cut / 10000 of the previous N (strictly decreasing while N ≥ 1). */
  cuts: fc.array(fc.integer({ min: 0, max: 9999 }), { minLength: 1, maxLength: 4 }),
  finalZero: fc.boolean(),
  self: person('self', 8000),
  direct: fc.option(person('direct', 1500), { nil: null }),
  indirect: fc.option(person('indirect', 500), { nil: null }),
});

type Verdict = 'credit' | 'held' | 'forfeit';

function verdictOf(p: Person): Verdict {
  if (p.state === 'frozen') return 'held';
  if (p.state === 'banned' || p.state === 'deleting') return 'forfeit';
  if (p.state === 'minor' && p.role !== 'self') return 'forfeit';
  return 'credit';
}

function positive(n: bigint): bigint {
  return n > 0n ? n : 0n;
}

/** The N sequence, cut at the first step that is R8 (inclusive). */
function steps(n0: bigint, reserveBp: number, cuts: readonly number[], finalZero: boolean) {
  const raw: bigint[] = [];
  let n = n0;
  for (const cut of cuts) {
    n = mulDivFloor(n, BigInt(cut), 10000n);
    raw.push(n);
  }
  if (finalZero) raw.push(0n);
  const out: bigint[] = [];
  let bookedBase = baseOf(n0, reserveBp).base;
  for (const next of raw) {
    out.push(next);
    const base = baseOf(next, reserveBp).base;
    if (positive(next) === 0n || (bookedBase > 0n && base === 0n)) {
      return { ns: out, r8: true };
    }
    bookedBase = base;
  }
  return { ns: out, r8: false };
}

interface Expected {
  readonly nets: ReadonlyMap<Role, bigint>;
  readonly pending: bigint;
}

function expectedAt(
  people: readonly Person[],
  n: bigint,
  reserveBp: number,
  r8: boolean,
): Expected {
  const nets = new Map<Role, bigint>();
  let pending = 0n;
  const base = baseOf(n, reserveBp).base;
  for (const p of people) {
    const share = shareOf(base, p.ratioBp);
    const verdict = verdictOf(p);
    const lost = p.after === 'banned' || p.after === 'deleting';
    if (r8 || verdict === 'forfeit') {
      nets.set(p.role, 0n);
    } else if (verdict === 'credit') {
      nets.set(p.role, share);
    } else {
      nets.set(p.role, 0n);
      if (!lost) pending = addFen(pending, share);
    }
  }
  return { nets, pending };
}

async function changeAfterCredit(h: Harness, o: SeededOrder, people: readonly Person[]) {
  for (const p of people) {
    const userId = o.user(p.role);
    if (p.after === 'banned' || p.after === 'frozen') await h.setRisk(h.db, userId, p.after);
    if (p.after === 'deleting') await h.markDeleting(userId);
  }
}

async function netsByRole(h: Harness, o: SeededOrder, people: readonly Person[]) {
  const stored = await h.nets(o);
  const byRole = new Map<Role, bigint>();
  for (const p of people) {
    const userId = o.user(p.role);
    const found = stored.beneficiaries.find(
      (b) => b.beneficiary_user_id === userId && b.role === p.role,
    );
    byRole.set(p.role, found?.net_fen ?? 0n);
  }
  return {
    byRole,
    platform: stored.platform_net_fen,
    receivable: stored.union_receivable_net_fen,
  };
}

async function checkState(
  h: Harness,
  o: SeededOrder,
  people: readonly Person[],
  n: bigint,
  reserveBp: number,
  r8: boolean,
  label: string,
) {
  const want = expectedAt(people, n, reserveBp, r8);
  const got = await netsByRole(h, o, people);
  let netSum = 0n;
  for (const p of people) {
    const net = got.byRole.get(p.role) ?? 0n;
    expect(net, `${label} ${p.role} net`).toBe(want.nets.get(p.role));
    // BR-FUND-08 invariant: a beneficiary's net on the order is never negative.
    expect(net >= 0n, `${label} ${p.role} net ≥ 0`).toBe(true);
    netSum = addFen(netSum, net);
    if (p.state !== 'deleting' && p.after !== 'deleting') {
      // Fresh users per order: the available balance is this order's net (BAD_DEBT never
      // touches a deleted beneficiary's account, so those are skipped).
      expect(await h.balance(o.user(p.role)), `${label} ${p.role} balance`).toBe(net);
    }
  }
  const nPositive = positive(n);
  expect(got.receivable, `${label} UNION_RECEIVABLE`).toBe(subFen(nPositive, want.pending));
  expect(got.platform, `${label} platform net`).toBe(
    subFen(subFen(nPositive, netSum), want.pending),
  );
  expect(await h.read(o), label).toMatchObject({
    rebate_status: r8 ? 'CLAWED_BACK' : 'CREDITED',
    booked_base_fen: baseOf(n, reserveBp).base,
    booked_n_fen: nPositive,
  });
  return got;
}

/** Runs the property; returns the number of checked scenarios. */
export async function assertClawbackProperty(h: Harness): Promise<number> {
  // Build the service and claw back one order before the property, so a broken harness or a
  // missing implementation shows up once, outside fast-check.
  h.boot();
  const warmup = await h.credited();
  const warmRights = await h.rights(warmup);
  expect(
    await h.apply(warmup, {
      cause: 'PARTIAL_REFUND',
      ref: { kind: 'rights', orderRightsId: warmRights },
      newCommissionFen: 600n,
    }),
  ).toMatchObject({ outcome: 'clawed_back', transition: 'R9' });

  let checked = 0;
  await fc.assert(
    fc.asyncProperty(scenario, async (s) => {
      const people: Person[] = [s.self, s.direct, s.indirect].flatMap((p) =>
        p === null ? [] : [p],
      );
      const specs: PersonSpec[] = people.map((p) => ({
        role: p.role,
        ratioBp: p.ratioBp,
        state: p.state,
      }));
      const { ns, r8 } = steps(s.n0, s.reserveBp, s.cuts, s.finalZero);
      const last = ns.at(-1) ?? s.n0;

      const multi = await h.credited({ people: specs, settleFen: s.n0, reserveBp: s.reserveBp });
      const once = await h.credited({ people: specs, settleFen: s.n0, reserveBp: s.reserveBp });
      await changeAfterCredit(h, multi, people);
      await changeAfterCredit(h, once, people);

      // Several adjustments, checked after every step.
      let lastRights = '';
      for (const [index, n] of ns.entries()) {
        lastRights = await h.rights(multi);
        const finalStep = index === ns.length - 1;
        const result = await h.apply(multi, {
          cause: 'PARTIAL_REFUND',
          ref: { kind: 'rights', orderRightsId: lastRights },
          newCommissionFen: n,
        });
        const stepR8 = finalStep && r8;
        expect(['clawed_back', 'no_change'], `step ${String(index)}`).toContain(result.outcome);
        await checkState(h, multi, people, n, s.reserveBp, stepR8, `multi step ${String(index)}`);
      }

      // One recomputation straight from the credit.
      const onceRights = await h.rights(once);
      await h.apply(once, {
        cause: 'PARTIAL_REFUND',
        ref: { kind: 'rights', orderRightsId: onceRights },
        newCommissionFen: last,
      });
      const a = await checkState(h, multi, people, last, s.reserveBp, r8, 'multi final');
      const b = await checkState(h, once, people, last, s.reserveBp, r8, 'one-shot');
      expect([...a.byRole.entries()]).toEqual([...b.byRole.entries()]);
      expect(a.platform).toBe(b.platform);
      expect(a.receivable).toBe(b.receivable);

      // Replaying the last step writes nothing more.
      const keys = await h.orderVoucherKeys(multi);
      const replay = await h.apply(multi, {
        cause: 'PARTIAL_REFUND',
        ref: { kind: 'rights', orderRightsId: lastRights },
        newCommissionFen: last,
      });
      expect(['no_change', 'skipped']).toContain(replay.outcome);
      expect(await h.orderVoucherKeys(multi)).toEqual(keys);
      await checkState(h, multi, people, last, s.reserveBp, r8, 'multi replay');
      checked += 1;
    }),
    { numRuns: clawbackRuns(), seed: propSeed() },
  );
  return checked;
}
