// B2-09d derived bill status rule tests (claude-independent, SPEC_REF 37808a50): the contract's
// AdminSettleBillStatus (enum admin_settle_bill_status; 08 BR-FUND-04 细则「月结账单状态」: derived
// from the batches of the bill's latest round, not stored; rejected CANCELLED batches take no
// part). Rounds: the first round is every kind main batch; each supplement launch is one round,
// the kind supplement batches sharing (platform, created_at); a round's time is the largest
// created_at of its batches; the latest round has the largest round time, a tie going to the round
// holding the largest batch_id. First rule that holds wins (now = the server clock):
// generating = generated_at null; issued = no batch of the round left that is not CANCELLED, or
// one is DRAFT; settled = every one DONE; settling = one EXECUTING / PARTIAL, or CONFIRMED with
// IMMEDIATE or scheduled_at not later than now; scheduled = otherwise. Pure function, no database.
// Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  deriveAdminSettleBill,
  type AdminSettleRoundBatch,
} from '../../../../apps/api/src/modules/settlement/application/admin-settle-bills.ts';

const NOW = new Date('2026-10-30T02:00:00.000Z');
const GENERATED = new Date('2026-10-01T00:12:00.000Z');
const MINUTE = 60_000;

function at(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * MINUTE);
}

type Seed = Partial<AdminSettleRoundBatch>;

/** A batch of the bill-day task (main, IMMEDIATE, created at generation) unless seeded. */
function batch(seed: Seed = {}): AdminSettleRoundBatch {
  return {
    batch_id: randomUUID(),
    platform: 'taobao',
    kind: 'main',
    status: 'DRAFT',
    settle_mode: 'IMMEDIATE',
    scheduled_at: null,
    created_at: GENERATED,
    ...seed,
  };
}

/** A CONFIRMED SCHEDULED batch due `minutes` after the clock (negative: before). */
function scheduledIn(minutes: number, seed: Seed = {}): AdminSettleRoundBatch {
  return batch({
    status: 'CONFIRMED',
    settle_mode: 'SCHEDULED',
    scheduled_at: at(minutes),
    ...seed,
  });
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

it('[AC-B2-09d#1] 账单状态按表逐条判定（只有首轮批次时）：generated_at 为空是 generating（即使已有批次）；无批次、有 DRAFT、全部被驳回都是 issued；全部 DONE（驳回的不算）是 settled；有 EXECUTING / PARTIAL，或 CONFIRMED 且立即结算或 scheduled_at 不晚于当前时刻是 settling；未完成的全是 CONFIRMED 且 scheduled_at 晚于当前时刻是 scheduled', () => {
  const cases: [string, Date | null, AdminSettleRoundBatch[], string][] = [
    ['generating, no batch yet', null, [], 'generating'],
    ['generating while batches are being written', null, [batch()], 'generating'],
    ['generating even if every batch is DONE', null, [batch({ status: 'DONE' })], 'generating'],
    ['issued, generated without any batch', GENERATED, [], 'issued'],
    ['issued, a DRAFT batch', GENERATED, [batch(), batch({ platform: 'jd' })], 'issued'],
    [
      'issued, DRAFT next to a confirmed batch',
      GENERATED,
      [batch(), batch({ platform: 'jd', status: 'CONFIRMED' })],
      'issued',
    ],
    [
      'issued, DRAFT next to an executing batch',
      GENERATED,
      [batch({ status: 'EXECUTING' }), batch({ platform: 'jd' })],
      'issued',
    ],
    [
      'issued, every batch rejected',
      GENERATED,
      [batch({ status: 'CANCELLED' }), batch({ platform: 'jd', status: 'CANCELLED' })],
      'issued',
    ],
    ['scheduled, due later', GENERATED, [scheduledIn(5)], 'scheduled'],
    [
      'scheduled, one DONE and one due later',
      GENERATED,
      [batch({ status: 'DONE' }), scheduledIn(60 * 24, { platform: 'jd' })],
      'scheduled',
    ],
    [
      'scheduled, a rejected batch takes no part',
      GENERATED,
      [scheduledIn(1), batch({ platform: 'jd', status: 'CANCELLED' })],
      'scheduled',
    ],
    ['settling, due exactly now', GENERATED, [scheduledIn(0)], 'settling'],
    ['settling, due a minute ago', GENERATED, [scheduledIn(-1)], 'settling'],
    [
      'settling, confirmed for immediate settlement',
      GENERATED,
      [batch({ status: 'CONFIRMED' })],
      'settling',
    ],
    ['settling, executing', GENERATED, [batch({ status: 'EXECUTING' })], 'settling'],
    ['settling, partial', GENERATED, [batch({ status: 'PARTIAL' })], 'settling'],
    [
      'settling, partial next to DONE',
      GENERATED,
      [batch({ status: 'DONE' }), batch({ platform: 'jd', status: 'PARTIAL' })],
      'settling',
    ],
    [
      'settling, executing next to one due later',
      GENERATED,
      [batch({ status: 'EXECUTING' }), scheduledIn(60, { platform: 'jd' })],
      'settling',
    ],
    [
      'settling, one due now next to one due later',
      GENERATED,
      [scheduledIn(-5), scheduledIn(60, { platform: 'jd' })],
      'settling',
    ],
    ['settled, every batch DONE', GENERATED, [batch({ status: 'DONE' })], 'settled'],
    [
      'settled, DONE next to a rejected batch',
      GENERATED,
      [batch({ status: 'DONE' }), batch({ platform: 'jd', status: 'CANCELLED' })],
      'settled',
    ],
  ];
  const wrong: string[] = [];
  for (const [name, generatedAt, batches, want] of cases) {
    const got = deriveAdminSettleBill(generatedAt, batches, NOW).status;
    if (got !== want) wrong.push(`${name}: ${got}, want ${want}`);
  }
  expect(wrong).toEqual([]);
  // The main round holds every main batch, CANCELLED included.
  const main = [batch({ status: 'DONE' }), batch({ platform: 'jd', status: 'CANCELLED' })];
  const derived = deriveAdminSettleBill(GENERATED, main, NOW);
  expect(sorted(derived.currentRound)).toEqual(sorted(main.map((b) => b.batch_id)));
  expect(deriveAdminSettleBill(GENERATED, [], NOW).currentRound).toEqual([]);
});

it('[AC-B2-09d#2] 最近一轮的判定：首轮 = 全部 main 批次（不论平台与 created_at）；每次补充 = (platform, created_at) 相同的 supplement 批次；轮时刻取轮内最大 created_at，最大者为最近一轮，同刻取含最大 batch_id 的一轮；只按最近一轮派生（旧轮的 DRAFT / DONE 不影响），本轮全被驳回回到 issued；currentRound 恰好是最近一轮的全部批次（含驳回的）', () => {
  const [small, large] = [randomUUID(), randomUUID()].sort() as [string, string];
  const t0 = GENERATED;
  const t1 = at(-60 * 24 * 3);
  const t2 = at(-60 * 24);
  const mainA = batch({ status: 'DONE', created_at: t0 });
  const mainB = batch({ platform: 'jd', status: 'DONE', created_at: new Date(t0.getTime() + 9) });
  const supplement = (seed: Seed) => batch({ kind: 'supplement', ...seed });

  const check = (
    name: string,
    batches: AdminSettleRoundBatch[],
    want: string,
    round: AdminSettleRoundBatch[],
  ) => {
    for (const order of [batches, [...batches].reverse()]) {
      const derived = deriveAdminSettleBill(GENERATED, order, NOW);
      expect(derived.status, name).toBe(want);
      expect(sorted(derived.currentRound), name).toEqual(sorted(round.map((b) => b.batch_id)));
    }
  };

  // Only the main round (its batches created at different instants are still one round).
  check('main only', [mainA, mainB], 'settled', [mainA, mainB]);
  // A supplement launch after a settled main round: its DRAFT batch decides.
  const s1 = supplement({ created_at: t1 });
  check('supplement DRAFT', [mainA, mainB, s1], 'issued', [s1]);
  // The supplement round rejected as a whole: issued, although the main round is settled.
  const s1Rejected = { ...s1, status: 'CANCELLED' };
  check('supplement rejected', [mainA, mainB, s1Rejected], 'issued', [s1Rejected]);
  // A later launch replaces it; the main round's DRAFT does not matter any more.
  const mainDraft = { ...mainB, status: 'DRAFT' };
  const s2 = supplement({ status: 'CONFIRMED', created_at: t2 });
  check('later supplement', [mainA, mainDraft, s1Rejected, s2], 'settling', [s2]);
  const s2Later = { ...s2, settle_mode: 'SCHEDULED', scheduled_at: at(30) };
  check('later supplement due later', [mainA, mainDraft, s1Rejected, s2Later], 'scheduled', [s2]);
  const s2Done = { ...s2, status: 'DONE' };
  check('later supplement done', [mainA, mainDraft, s1Rejected, s2Done], 'settled', [s2]);
  // One launch: the supplement batches sharing (platform, created_at), here one DONE, one DRAFT.
  const s3a = supplement({ status: 'DONE', created_at: t2 });
  const s3b = supplement({ status: 'DRAFT', created_at: t2 });
  check('one launch, two batches', [mainA, mainB, s1Rejected, s3a, s3b], 'issued', [s3a, s3b]);
  // Two launches at the same instant on different platforms are two rounds: the tie goes to the
  // round holding the largest batch_id.
  const tieDone = supplement({ batch_id: small, status: 'DONE', created_at: t2 });
  const tieDraft = supplement({ batch_id: large, platform: 'jd', created_at: t2 });
  check('tie, larger id DRAFT', [mainA, mainB, tieDone, tieDraft], 'issued', [tieDraft]);
  const tieDone2 = supplement({ batch_id: large, status: 'DONE', created_at: t2 });
  const tieDraft2 = supplement({ batch_id: small, platform: 'jd', created_at: t2 });
  check('tie, larger id DONE', [mainA, mainB, tieDone2, tieDraft2], 'settled', [tieDone2]);
  // The main round keeps being the latest while no supplement is later than its latest batch.
  const mainLate = batch({ platform: 'pdd', status: 'DRAFT', created_at: at(-10) });
  const early = supplement({ status: 'DONE', created_at: t1 });
  check('main round latest', [mainA, mainB, early, mainLate], 'issued', [mainA, mainB, mainLate]);
});

/** The contract's rule written out (test-side oracle). */
function oracle(
  generatedAt: Date | null,
  batches: readonly AdminSettleRoundBatch[],
  now: Date,
): { status: string; currentRound: string[] } {
  const groups = new Map<string, AdminSettleRoundBatch[]>();
  for (const b of batches) {
    const key = b.kind === 'main' ? 'main' : `supplement|${b.platform}|${b.created_at.getTime()}`;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  let best: { time: number; maxId: string; batches: AdminSettleRoundBatch[] } | undefined;
  for (const group of groups.values()) {
    const time = Math.max(...group.map((b) => b.created_at.getTime()));
    const maxId = group.map((b) => b.batch_id).sort()[group.length - 1]!;
    if (best === undefined || time > best.time || (time === best.time && maxId > best.maxId)) {
      best = { time, maxId, batches: group };
    }
  }
  const round = best?.batches ?? [];
  const currentRound = round.map((b) => b.batch_id).sort();
  if (generatedAt === null) return { status: 'generating', currentRound };
  const live = round.filter((b) => b.status !== 'CANCELLED');
  if (live.length === 0 || live.some((b) => b.status === 'DRAFT')) {
    return { status: 'issued', currentRound };
  }
  if (live.every((b) => b.status === 'DONE')) return { status: 'settled', currentRound };
  const due = (b: AdminSettleRoundBatch) =>
    b.status === 'EXECUTING' ||
    b.status === 'PARTIAL' ||
    (b.status === 'CONFIRMED' &&
      (b.settle_mode === 'IMMEDIATE' ||
        (b.scheduled_at !== null && b.scheduled_at.getTime() <= now.getTime())));
  if (live.some(due)) return { status: 'settling', currentRound };
  return { status: 'scheduled', currentRound };
}

const STATES = ['DRAFT', 'CONFIRMED', 'EXECUTING', 'PARTIAL', 'DONE', 'CANCELLED'] as const;

const arbBatch: fc.Arbitrary<AdminSettleRoundBatch> = fc
  .record({
    batch_id: fc.uuid(),
    platform: fc.constantFrom('taobao', 'jd', 'pdd'),
    kind: fc.constantFrom('main', 'supplement'),
    status: fc.constantFrom(...STATES),
    scheduled: fc.boolean(),
    // Few distinct instants, so that launches share created_at and round times tie.
    createdStep: fc.integer({ min: 0, max: 3 }),
    dueMinutes: fc.integer({ min: -3, max: 3 }),
  })
  .map((r) => ({
    batch_id: r.batch_id,
    platform: r.platform,
    kind: r.kind,
    status: r.status,
    settle_mode: r.scheduled ? 'SCHEDULED' : 'IMMEDIATE',
    scheduled_at: r.scheduled ? at(r.dueMinutes) : null,
    created_at: new Date(GENERATED.getTime() + r.createdStep * 60 * 24 * MINUTE),
  }));

it('[AC-B2-09d#3] 随机批次集合（主批次 / 补充批次、六种状态、立即 / 定时且定时时刻在当前时刻前后、轮时刻相同）：派生状态与 currentRound 与契约规则逐一相同，且与批次的输入顺序无关', () => {
  fc.assert(
    fc.property(
      fc.option(fc.constant(GENERATED), { freq: 6 }),
      fc.uniqueArray(arbBatch, { maxLength: 8, selector: (b) => b.batch_id }),
      (generatedAt, batches) => {
        const want = oracle(generatedAt, batches, NOW);
        for (const order of [batches, [...batches].reverse()]) {
          const got = deriveAdminSettleBill(generatedAt, order, NOW);
          expect(got.status).toBe(want.status);
          if (generatedAt !== null) expect(sorted(got.currentRound)).toEqual(want.currentRound);
        }
      },
    ),
    { numRuns: 400 },
  );
});
