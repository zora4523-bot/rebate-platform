// B3-03g crash-injection model (design §7.1, §4.2): ending × cards × cancel timing × crash point ×
// recovery action × recovery clock; the expected ending is computed only from the commit log
// (first committed decision UPDATE and whether a cancel was committed before it), never from
// consent / switch events. Checks I1 I2 I3a I5 I6 I7 I12 I13 I15 I17 I19 on real PostgreSQL.
// The expected settlement comes from the BR-AI-15 refund list written out below, not from the
// code under test. Each sample returns its list of violated invariants; the property is "the
// list is empty" (a boolean), asserted once outside fc.check. Runs and seed come only from
// PROP_RUNS / PROP_SEED (runs scaled, see MODEL_RUNS).
import { createTestDatabase } from '@couli/db/testing';
import { isDeepStrictEqual } from 'node:util';

import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type {
  AdmissionLimits,
  RunEnding,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import type { CrashPoint } from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import {
  APP,
  MutableLimits,
  START_MS,
  draftOf,
  instance,
  limits,
  member,
  memberKey,
  newSession,
  request,
  settled,
  stored,
  usedOn,
  usePg,
  type Row,
} from './kit.ts';

const pg = usePg(createTestDatabase);
const DEADLINE = START_MS + 20_000;
const LOCK_END = START_MS + 50_000;
const QUOTA = limits({ memberDaily: 3 });
/**
 * Runs of the model (orchestrator ruling 2026-10-09): every sample is a real-database scenario
 * (a fresh session, admission, up to a dozen transactions, recovery), about 100 times the cost of a
 * pure sample, while PROP_RUNS defaults to 10 000 and the test container stops at 1 200 s. So the
 * count follows PROP_RUNS scaled by 1/100 with a floor of 20: numRuns = max(20, floor(PROP_RUNS /
 * 100)) (PROP_RUNS 10 000 → 100, 1 000 000 → 10 000); the seed is PROP_SEED as it is.
 */
const MODEL_RUNS = Math.max(20, Math.floor(propRuns() / 100));
/** Timeout from the scaled count: 60 s of fixed cost plus 1 s per sample (shrinking included). */
const MODEL_TIMEOUT_MS = 60_000 + MODEL_RUNS * 1_000;

/**
 * BR-AI-15 (SPEC_REF b3924b1) refund list, written out independently of shouldRefund: a run that
 * ends for a server-side reason — a 5xxxx server error, the Agent switch turned off, the input
 * review timing out (fail-close) or the run timing out — and delivered no card gives its 1 back.
 * Everything else counts as usual: user cancel (and a dropped connection), content-safety block,
 * intent refusal, the no-model fallback, auth_required, budget / limit, client-side errors and a
 * withdrawn AI consent (BR-AI-13: not refunded).
 */
const REFUNDED_WHEN_NO_CARD: ReadonlySet<string> = new Set([
  'server_error',
  'disabled',
  'input_review_timeout',
  'timeout',
]);
function expectRefund(ending: string, cardDelivered: boolean): boolean {
  return !cardDelivered && REFUNDED_WHEN_NO_CARD.has(ending);
}

/** A limits source that records instead of asserting (assertions stay outside the property). */
class ModelLimits extends MutableLimits {
  readonly apps: string[] = [];
  override current(appId: string): Promise<AdmissionLimits> {
    this.calls += 1;
    this.apps.push(appId);
    return Promise.resolve({ ...this.value });
  }
}

type Crash = null | { point: CrashPoint; phase: 'before' | 'after' };
interface Case {
  ending: RunEnding;
  cards: 0 | 1 | 2;
  cancel: 'none' | 'before_s4' | 'after_s4' | 'after_deadline';
  crash: Crash;
  recovery: 'finalize' | 'same_key' | 'new_message';
  recoveryAt: number;
}

const ENDINGS: RunEnding[] = [
  'stop',
  'server_error',
  'client_error',
  'consent_withdrawn',
  'disabled',
  'timeout',
  'cancelled',
  'disconnected',
  'input_review_timeout',
];
const CRASHES: Crash[] = [
  null,
  { point: 'facts', phase: 'before' },
  { point: 'ending', phase: 'before' },
  { point: 'ending', phase: 'after' },
  { point: 'settle', phase: 'before' },
  { point: 'settle', phase: 'after' },
  { point: 'finish', phase: 'before' },
];

const caseArb: fc.Arbitrary<Case> = fc.record({
  ending: fc.constantFrom(...ENDINGS),
  cards: fc.constantFrom(0 as const, 1 as const, 2 as const),
  cancel: fc.constantFrom(
    'none' as const,
    'before_s4' as const,
    'after_s4' as const,
    'after_deadline' as const,
  ),
  crash: fc.constantFrom(...CRASHES),
  recovery: fc.constantFrom('finalize' as const, 'same_key' as const, 'new_message' as const),
  recoveryAt: fc.constantFrom(0, 1, 999),
});

async function rowOf(table: 'agent_runs' | 'agent_sessions', id: string): Promise<Row | null> {
  const r = await sql<Row>`SELECT * FROM ${sql.table(`app.${table}`)} WHERE id = ${id}`.execute(
    pg.db,
  );
  return r.rows.length === 1 ? r.rows[0]! : null;
}

const same = (x: unknown, y: unknown): boolean =>
  isDeepStrictEqual(JSON.parse(JSON.stringify(x ?? null)), JSON.parse(JSON.stringify(y ?? null)));

/** One sample; returns the violated invariants (empty = the sample holds). */
async function play(c: Case): Promise<string[]> {
  const violations: string[] = [];
  const check = (ok: boolean, what: string): void => {
    if (!ok) violations.push(what);
  };
  try {
    const live = new ModelLimits(QUOTA);
    const a = instance(pg.db, { limits: live });
    const canceller = instance(pg.db, { clock: new FixedClock(new Date(START_MS)) });
    const user = member();
    const session = await newSession(pg.db);
    const req = request(user, session);
    const admitted = await a.ports.admission.admit(req, QUOTA);
    if (admitted.kind !== 'accepted') return [`admit: ${JSON.stringify(admitted)}`];
    const { ticket } = admitted;
    if (c.crash) a.hooks.crashAt(c.crash.point, c.crash.phase);

    // Commit log of the model.
    let s3Committed = false;
    let cancelCommittedBeforeS4 = false;
    let cancelAnswer: string | null = null;

    a.clock.set(new Date(START_MS + 3_000));
    if (c.cards > 0) {
      const r = await settled(
        a.ports.registry.recordFacts(ticket.runId, { ending: null, cardsDelivered: c.cards }),
      );
      s3Committed = !(r instanceof Error);
    }
    if (c.cancel === 'before_s4') {
      canceller.clock.set(new Date(START_MS + 5_000));
      cancelAnswer = await canceller.ports.cancel({ appId: APP, runId: ticket.runId });
      cancelCommittedBeforeS4 = cancelAnswer === 'accepted';
    }
    a.clock.set(new Date(START_MS + 6_000));
    const facts = { ending: c.ending, cardsDelivered: s3Committed ? c.cards : 0 };
    const draft = draftOf(c.ending);
    const s4 = await settled(a.ports.registry.recordEnding(ticket.runId, facts, draft));
    const s4Committed =
      !(s4 instanceof Error) || (c.crash?.point === 'ending' && c.crash.phase === 'after');
    if (c.cancel === 'after_s4') {
      canceller.clock.set(new Date(START_MS + 7_000));
      cancelAnswer = await canceller.ports.cancel({ appId: APP, runId: ticket.runId });
    }
    if (c.cancel === 'after_deadline') {
      canceller.clock.set(new Date(DEADLINE + 1_000));
      cancelAnswer = await canceller.ports.cancel({ appId: APP, runId: ticket.runId });
    }
    let sent: unknown = null;
    await settled(a.ports.registry.recordFacts(ticket.runId, facts, draft));
    const settledResult = await settled(a.ports.admission.settle(ticket, facts, QUOTA));
    if (!(settledResult instanceof Error)) {
      const finished = await settled(
        a.ports.registry.finish(ticket.runId, {
          event: 'error',
          data: { code: 50001, msg: 'local', retryable: true, fallback: null },
        }),
      );
      if (!(finished instanceof Error)) sent = finished;
    }

    // Recovery after the lock period, then quiescence.
    const recoveryLimits = new ModelLimits(QUOTA);
    const r = instance(pg.db, {
      clock: new FixedClock(new Date(LOCK_END + c.recoveryAt)),
      limits: recoveryLimits,
    });
    let replay: unknown = null;
    let newRunId: string | null = null;
    if (c.recovery === 'finalize') await r.ports.finalizer.finalize(ticket.runId);
    if (c.recovery === 'same_key') {
      const dup = await r.ports.admission.admit(request(user, session, req.clientMsgId), QUOTA);
      check(
        dup.kind === 'duplicate' && dup.reply.kind === 'final',
        `same_key: duplicate final, got ${JSON.stringify(dup)}`,
      );
      if (dup.kind === 'duplicate' && dup.reply.kind === 'final') replay = dup.reply.frame;
    }
    if (c.recovery === 'new_message') {
      const fresh = request(user, session);
      const next = await r.ports.admission.admit(fresh, QUOTA);
      check(next.kind === 'accepted', `new_message: accepted, got ${JSON.stringify(next)}`);
      newRunId = fresh.runId;
    }
    const again = await r.ports.finalizer.finalize(ticket.runId);
    check(again.kind === 'final', `I13 finalize after recovery: ${JSON.stringify(again)}`);

    // Expected from the commit log only.
    const cancelBeforeDecision =
      cancelCommittedBeforeS4 || (!s4Committed && cancelAnswer === 'accepted');
    const expectedEnding: string = cancelBeforeDecision
      ? 'cancelled'
      : s4Committed
        ? c.ending
        : 'server_error';
    const refund = expectRefund(expectedEnding, s3Committed);
    const row = await rowOf('agent_runs', ticket.runId);
    if (row === null) return [...violations, 'agent_runs row missing'];
    check(
      row['end_reason'] === expectedEnding,
      `I6 end_reason ${String(row['end_reason'])} ≠ ${expectedEnding}`,
    );
    check(
      row['card_delivered'] === s3Committed,
      `I15 card_delivered ${String(row['card_delivered'])}`,
    );
    check(
      row['settle_result'] === (refund ? 'refunded' : 'counted'),
      `I2 settle_result ${String(row['settle_result'])}, BR-AI-15 expects ${refund ? 'refunded' : 'counted'}`,
    );
    const used = await usedOn(pg.db, memberKey(user), '2026-10-06');
    const expectedUsed = (refund ? 0 : 1) + (c.recovery === 'new_message' ? 1 : 0);
    check(used === expectedUsed, `I1 I7 used ${String(used)} ≠ ${String(expectedUsed)}`);
    const acceptedAt = row['accepted_at'];
    check(
      acceptedAt instanceof Date && acceptedAt.getTime() === START_MS,
      `I7 accepted_at ${String(acceptedAt)}`,
    );
    if (c.cancel === 'before_s4')
      check(cancelAnswer === 'accepted', `cancel before S4: ${String(cancelAnswer)}`);
    if (c.cancel === 'after_s4') {
      const want = s4Committed ? 'not_running' : 'accepted';
      check(cancelAnswer === want, `cancel after S4: ${String(cancelAnswer)} ≠ ${want}`);
    }
    if (c.cancel === 'after_deadline')
      check(cancelAnswer === 'not_running', `deadline: ${String(cancelAnswer)}`);
    if (cancelAnswer === 'accepted')
      check(row['end_reason'] === 'cancelled', 'I19 accepted ⇒ cancelled');
    if (cancelAnswer === 'not_running') {
      check(
        row['cancel_requested_at'] === null,
        'I19 not_running ⇒ cancel_requested_at not written',
      );
    }
    const final = row['final_event'] as { type: string; data: Record<string, unknown> } | null;
    check(final !== null, 'I13 final_event written');
    if (final !== null) {
      // I17: quota_left = the BR-AI-15 remaining at finalization (R is finalized before any other
      // run of this user is accepted), never below 0.
      if (final.type === 'done') {
        const wantLeft = QUOTA.memberDaily - (refund ? 0 : 1);
        check(
          final.data['quota_left'] === wantLeft,
          `I17 quota_left ${String(final.data['quota_left'])} ≠ ${String(wantLeft)}`,
        );
      }
      const expectedDraft = cancelBeforeDecision
        ? stored(draftOf('cancelled'))
        : s4Committed
          ? stored(draft)
          : {
              type: 'error',
              data: { code: 50001, msg: '错误提示-50001', retryable: true, fallback: null },
            };
      const { quota_left: _left, ...finalData } = final.data;
      void _left;
      check(
        same({ type: final.type, data: finalData }, expectedDraft),
        `I5 I6 final_event ${JSON.stringify(final)} from draft ${JSON.stringify(expectedDraft)}`,
      );
      if (sent !== null)
        check(same(stored(sent as never), final), `I3a sent ${JSON.stringify(sent)}`);
      if (replay !== null)
        check(same(stored(replay as never), final), `I3a replay ${JSON.stringify(replay)}`);
      if (again.kind === 'final') check(same(stored(again.frame), final), 'I3a finalize replay');
    }
    const lock = await rowOf('agent_sessions', session);
    check(
      (lock?.['run_lock_run_id'] ?? null) === newRunId,
      `I12 session lock ${String(lock?.['run_lock_run_id'])} ≠ ${String(newRunId)}`,
    );
    check(
      [...live.apps, ...recoveryLimits.apps].every((app) => app === APP),
      `limits read for ${JSON.stringify([...live.apps, ...recoveryLimits.apps])}`,
    );
  } catch (error) {
    violations.push(
      `threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  }
  return violations;
}

it(
  '[AC-B3-03g#43] 崩溃注入模型：任意结局 × 卡片 × 取消时机 × 崩溃点 × 恢复方式，终止原因只由提交日志决定，只结算一次、退还记受理日、终态 = 发出的帧、静止后无未结束 run',
  async () => {
    // The ports must exist before sampling (a missing implementation fails here, not as a sample).
    instance(pg.db);
    const failures = new Map<string, string[]>();
    const details = await fc.check(
      fc.asyncProperty(caseArb, async (c) => {
        const violations = await play(c);
        if (violations.length > 0) failures.set(JSON.stringify(c), violations);
        return violations.length === 0;
      }),
      { numRuns: MODEL_RUNS, seed: propSeed() },
    );
    const counterexample = details.counterexample?.[0];
    const why =
      counterexample === undefined ? [] : (failures.get(JSON.stringify(counterexample)) ?? []);
    expect(details.failed, `${fc.defaultReportMessage(details) ?? ''}\n${why.join('\n')}`).toBe(
      false,
    );
  },
  MODEL_TIMEOUT_MS,
);

it('[AC-B3-03g#44] 模型的确定性角：S4 后崩溃的 consent_withdrawn 不退、S4 前崩溃的 consent_withdrawn 按 50001 退、取消先于 S4 的崩溃 run 为 cancelled', async () => {
  instance(pg.db);
  const corners: Case[] = [
    {
      ending: 'consent_withdrawn',
      cards: 0,
      cancel: 'none',
      crash: { point: 'ending', phase: 'after' },
      recovery: 'finalize',
      recoveryAt: 0,
    },
    {
      ending: 'consent_withdrawn',
      cards: 0,
      cancel: 'none',
      crash: { point: 'ending', phase: 'before' },
      recovery: 'same_key',
      recoveryAt: 1,
    },
    {
      ending: 'timeout',
      cards: 1,
      cancel: 'before_s4',
      crash: { point: 'ending', phase: 'before' },
      recovery: 'new_message',
      recoveryAt: 999,
    },
  ];
  for (const corner of corners) {
    expect(await play(corner), JSON.stringify(corner)).toEqual([]);
  }
  // The independent BR-AI-15 list itself, at the corners the model relies on.
  expect(expectRefund('consent_withdrawn', false)).toBe(false);
  expect(expectRefund('server_error', false)).toBe(true);
  expect(expectRefund('server_error', true)).toBe(false);
  expect(expectRefund('cancelled', false)).toBe(false);
});
