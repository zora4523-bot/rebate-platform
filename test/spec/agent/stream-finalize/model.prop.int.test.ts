// B3-03g crash-injection model (design §7.1, §4.2): ending × cards × cancel timing × crash point ×
// recovery action × recovery clock; the expected ending is computed only from the commit log
// (first committed decision UPDATE and whether a cancel was committed before it), never from
// consent / switch events. Checks I1 I2 I3a I5 I6 I7 I12 I13 I15 I17 I19 on real PostgreSQL.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  shouldRefund,
  type RunEnding,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import type { CrashPoint } from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import {
  APP,
  MutableLimits,
  START_MS,
  accepted,
  draftOf,
  instance,
  limits,
  member,
  memberKey,
  newSession,
  request,
  runRow,
  sessionRow,
  settled,
  stored,
  usedOn,
  usePg,
} from './kit.ts';

const pg = usePg();
const DEADLINE = START_MS + 20_000;
const LOCK_END = START_MS + 50_000;
const QUOTA = limits({ memberDaily: 3 });

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

async function play(c: Case): Promise<void> {
  const label = JSON.stringify(c);
  const a = instance(pg.db, { limits: new MutableLimits(QUOTA) });
  const canceller = instance(pg.db, { clock: new FixedClock(new Date(START_MS)) });
  const user = member();
  const session = await newSession(pg.db);
  const req = request(user, session);
  const { ticket } = accepted(await a.ports.admission.admit(req, QUOTA));
  if (c.crash) a.hooks.crashAt(c.crash.point, c.crash.phase);

  // Commit log of the model.
  let s3Committed = false;
  let s4Committed = false;
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
  s4Committed =
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
  const r = instance(pg.db, {
    clock: new FixedClock(new Date(LOCK_END + c.recoveryAt)),
    limits: new MutableLimits(QUOTA),
  });
  if (c.recovery === 'finalize') await r.ports.finalizer.finalize(ticket.runId);
  if (c.recovery === 'same_key')
    await r.ports.admission.admit(request(user, session, req.clientMsgId), QUOTA);
  if (c.recovery === 'new_message') await r.ports.admission.admit(request(user, session), QUOTA);
  const again = await r.ports.finalizer.finalize(ticket.runId);
  expect(again.kind, label).toBe('final');

  // Expected from the commit log only.
  const cancelBeforeDecision =
    cancelCommittedBeforeS4 || (!s4Committed && cancelAnswer === 'accepted');
  const expectedEnding: string = cancelBeforeDecision
    ? 'cancelled'
    : s4Committed
      ? c.ending
      : 'server_error';
  const row = await runRow(pg.db, ticket.runId);
  expect(row['end_reason'], `${label} I6`).toBe(expectedEnding);
  expect(row['card_delivered'], `${label} I15`).toBe(s3Committed);
  const refunded = shouldRefund({
    ending: expectedEnding as RunEnding,
    cardsDelivered: s3Committed ? 1 : 0,
  });
  expect(row['settle_result'], `${label} I2`).toBe(refunded ? 'refunded' : 'counted');
  expect(await usedOn(pg.db, memberKey(user), '2026-10-06'), `${label} I1 I7`).toBe(
    (refunded ? 0 : 1) + (c.recovery === 'new_message' ? 1 : 0),
  );
  expect(row['accepted_at'], `${label} I7`).toEqual(new Date(START_MS));
  if (c.cancel === 'after_deadline') expect(cancelAnswer, `${label} deadline`).toBe('not_running');
  if (cancelAnswer === 'accepted') expect(row['end_reason'], `${label} I19`).toBe('cancelled');
  if (cancelAnswer === 'not_running' && c.cancel !== 'before_s4') {
    expect(row['cancel_requested_at'] === null || cancelCommittedBeforeS4, `${label} I19`).toBe(
      true,
    );
  }
  const final = row['final_event'] as { type: string; data: Record<string, unknown> } | null;
  expect(final, `${label} I13`).not.toBeNull();
  if (final?.type === 'done') {
    const left = final.data['quota_left'] as number;
    expect(left, `${label} I17`).toBeGreaterThanOrEqual(0);
  }
  if (sent !== null) expect(stored(sent as never), `${label} I3a`).toEqual(final);
  if (c.recovery !== 'new_message') {
    expect((await sessionRow(pg.db, session))['run_lock_run_id'], `${label} I12`).toBeNull();
  }
}

it('[AC-B3-03g#43] 崩溃注入模型：任意结局 × 卡片 × 取消时机 × 崩溃点 × 恢复方式，终止原因只由提交日志决定，只结算一次、退还记受理日、终态 = 发出的帧、静止后无未结束 run', async () => {
  // The ports must exist before sampling (a missing implementation fails here, not as a sample).
  instance(pg.db);
  const params = propParams();
  // Each sample is a dozen database round trips: cap the runs, keep PROP_SEED.
  const details = await fc.check(
    fc.asyncProperty(caseArb, async (c) => {
      await play(c);
      return true;
    }),
    { ...params, numRuns: Math.min(params.numRuns, 60) },
  );
  expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
}, 600_000);

it('[AC-B3-03g#44] 模型的确定性角：S4 后崩溃的 consent_withdrawn 不退、S4 前崩溃的 consent_withdrawn 按 50001 退、取消先于 S4 的崩溃 run 为 cancelled', async () => {
  await play({
    ending: 'consent_withdrawn',
    cards: 0,
    cancel: 'none',
    crash: { point: 'ending', phase: 'after' },
    recovery: 'finalize',
    recoveryAt: 0,
  });
  await play({
    ending: 'consent_withdrawn',
    cards: 0,
    cancel: 'none',
    crash: { point: 'ending', phase: 'before' },
    recovery: 'same_key',
    recoveryAt: 1,
  });
  await play({
    ending: 'timeout',
    cards: 1,
    cancel: 'before_s4',
    crash: { point: 'ending', phase: 'before' },
    recovery: 'new_message',
    recoveryAt: 999,
  });
});
