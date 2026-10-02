import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { LEASE_MS } from './lock.ts';
import {
  ATTEMPT_LIMITS,
  bumpAttempt,
  type CallMeta,
  claimDir,
  claimTask,
  listStates,
  MAX_CALLS_PER_TASK,
  MAX_CONSECUTIVE_NO_OUTPUT,
  migrateState,
  readState,
  releaseTask,
  reviewKind,
  settleCall,
  stateFile,
  taskCalls,
  uncountedReason,
  updateState,
} from './state.ts';
import { CLI_TIMEOUT, removeDir, runCli, scratchDir } from './test-helpers.ts';

const T0 = new Date('2026-10-01T04:00:00.000Z');
const later = (ms: number): Date => new Date(T0.getTime() + ms);

let runs = '';

beforeAll(() => {
  runs = join(scratchDir('state'), 'runs');
  process.env.COULI_RUNS = runs;
});
afterAll(() => removeDir(join(runs, '..')));

it('creates the state file on first use and writes it atomically', () => {
  expect(readState('A1-01')).toBeNull();
  const state = updateState('A1-01', { state: 'doing', pid: 4242 }, T0);
  expect(state).toEqual({
    id: 'A1-01',
    state: 'doing',
    attempts: { impl: 0, 'spec-test': 0, code: 0 },
    spec_commit: null,
    pid: 4242,
    started_at: T0.toISOString(),
    owner_session: null,
    lease_until: null,
    ask_created_at: null,
    last_error: null,
    uncounted_calls: [],
    updated_at: T0.toISOString(),
  });
  expect(JSON.parse(readFileSync(stateFile('A1-01'), 'utf8'))).toEqual(state);
  // No temporary file is left next to it.
  expect(readdirSync(join(runs, 'state'))).toEqual(['A1-01.json']);
});

it('records when a task entered `ask` and forgets it when the task leaves', () => {
  updateState('A1-02', { state: 'ask' }, T0);
  const again = updateState('A1-02', { last_error: '/x/err.txt' }, later(3600_000));
  expect(again.ask_created_at).toBe(T0.toISOString());
  expect(updateState('A1-02', { state: 'doing' }, later(7200_000)).ask_created_at).toBeNull();
});

it('counts attempts before dispatch and refuses to go past the limits', () => {
  expect(bumpAttempt('A1-03', 'impl', T0).attempts).toEqual({ impl: 1, 'spec-test': 0, code: 0 });
  bumpAttempt('A1-03', 'impl', T0);
  expect(bumpAttempt('A1-03', 'impl', T0).attempts.impl).toBe(3);
  // Persisted: a crash right after the bump still counts the attempt.
  expect(readState('A1-03')?.attempts.impl).toBe(3);
  expect(() => bumpAttempt('A1-03', 'impl', T0)).toThrow(/impl attempts exhausted \(3 of 3/);
  expect(readState('A1-03')?.attempts.impl).toBe(3);
});

it('[规划/11 §2.5] each review type has its own limit of 2 rounds', () => {
  expect(ATTEMPT_LIMITS).toEqual({ impl: 3, 'spec-test': 2, code: 2 });
  expect(reviewKind('spec-test')).toBe('spec-test');
  for (const type of ['money', 'general', 'contract'] as const)
    expect(reviewKind(type)).toBe('code');
  bumpAttempt('A1-07', 'spec-test', T0);
  bumpAttempt('A1-07', 'spec-test', T0);
  expect(() => bumpAttempt('A1-07', 'spec-test', T0)).toThrow(
    /spec-test attempts exhausted \(2 of 2/,
  );
  // Two spec-test rounds used up do not take anything from the code review.
  bumpAttempt('A1-07', 'code', T0);
  expect(bumpAttempt('A1-07', 'code', T0).attempts).toEqual({ impl: 0, 'spec-test': 2, code: 2 });
  expect(() => bumpAttempt('A1-07', 'code', T0)).toThrow(/code attempts exhausted \(2 of 2/);
});

function meta(over: Partial<CallMeta> = {}): CallMeta {
  return {
    mode: 'review',
    review_type: 'spec-test',
    started_at: '2026-10-02T03:14:01Z',
    exit_code: 0,
    has_output: true,
    idle_killed: false,
    validation: 'ok',
    ...over,
  };
}

it('[规划/11 §2.5] only a call that ended without output gives its round back', () => {
  const noOutput = { has_output: false, validation: 'not-run' };
  expect(uncountedReason(meta())).toBeNull();
  expect(uncountedReason(meta({ ...noOutput, exit_code: 124 }))).toBe('timeout');
  expect(uncountedReason(meta({ ...noOutput, exit_code: 124, idle_killed: true }))).toBe(
    'inactivity-kill',
  );
  expect(uncountedReason(meta({ ...noOutput, exit_code: 11 }))).toBe('capacity');
  // No -o file, turn.failed, non-zero Codex exit: the wrapper never validated an answer.
  expect(uncountedReason(meta({ ...noOutput, exit_code: 10 }))).toBe('no-output');
  // An answer that failed validation, and a position assertion failure, stay counted.
  expect(uncountedReason(meta({ has_output: false, exit_code: 10, validation: 'failed' }))).toBe(
    null,
  );
  expect(uncountedReason(meta({ ...noOutput, exit_code: 12 }))).toBeNull();
});

it('[规划/11 §2.5] settle takes a timed-out review back once, on its own counter', () => {
  bumpAttempt('A1-08', 'spec-test', T0);
  bumpAttempt('A1-08', 'code', T0);
  const timedOut = meta({ exit_code: 124, has_output: false, validation: 'not-run' });
  const first = settleCall('A1-08', timedOut, later(1000));
  expect(first).toMatchObject({ kind: 'spec-test', counted: false, changed: true });
  expect(first.state?.attempts).toEqual({ impl: 0, 'spec-test': 0, code: 1 });
  expect(first.state?.uncounted_calls).toEqual([
    { kind: 'spec-test', started_at: timedOut.started_at, exit_code: 124, reason: 'timeout' },
  ]);
  // Idempotent: settling the same call again (post-run, a retry of the wrapper) changes nothing.
  expect(settleCall('A1-08', timedOut, later(2000))).toMatchObject({ changed: false });
  expect(readState('A1-08')?.attempts).toEqual({ impl: 0, 'spec-test': 0, code: 1 });
  // A call with output keeps its round.
  const ok = meta({ review_type: 'money', started_at: '2026-10-02T04:00:00Z' });
  expect(settleCall('A1-08', ok, later(3000))).toMatchObject({ counted: true, changed: false });
  // An implementation killed by the hard timeout does not use up an attempt either.
  bumpAttempt('A1-08', 'impl', T0);
  const implTimeout = meta({
    mode: 'impl',
    review_type: null,
    started_at: '2026-10-02T05:00:00Z',
    exit_code: 124,
    has_output: false,
    validation: 'not-run',
  });
  expect(settleCall('A1-08', implTimeout, later(4000)).state?.attempts.impl).toBe(0);
  // Without a state file there is nothing to settle.
  expect(settleCall('Z9-99', timedOut, T0)).toMatchObject({ state: null, changed: false });
});

it('[规划/11 §2.5] migrates the old shared review counter from the run history', () => {
  // The B2-01a history of 2026-10-02: one implementation, then a spec-test review killed by the
  // hard timeout (exit 124, no output) and a spec-test review that returned "fail".
  const id = 'B9-01a';
  writeFileSync(
    stateFile(id),
    JSON.stringify({
      id,
      state: 'blocked',
      attempts: { impl: 1, review: 2 },
      spec_commit: '4de67a1808681f7085c49adf5a64c8aaa6ddcfa4',
      pid: null,
      started_at: null,
      owner_session: null,
      lease_until: null,
      ask_created_at: null,
      last_error: '/runs/B9-01a/r2-fix-input.txt',
      updated_at: T0.toISOString(),
    }),
  );
  expect(() => readState(id)).toThrow(/old shape .*state\.ts migrate B9-01a/);
  const run = join(runs, id);
  const call = (over: Record<string, unknown>) => ({
    task: id,
    finished_at: '2026-10-02T03:59:00Z',
    has_output: false,
    idle_killed: false,
    ...over,
  });
  mkdirSync(join(run, 'attempts', '1'), { recursive: true });
  const files: Record<string, unknown> = {
    'meta.impl.json': call({
      mode: 'impl',
      started_at: '2026-10-01T19:40:00Z',
      exit_code: 0,
      has_output: true,
      validation: 'ok',
    }),
    'attempts/1/meta.json': call({
      mode: 'review',
      review_type: 'spec-test',
      started_at: '2026-10-02T03:14:01Z',
      exit_code: 124,
      timed_out: true,
      validation: 'not-run',
    }),
    'meta.review.json': call({
      mode: 'review',
      review_type: 'spec-test',
      started_at: '2026-10-02T03:32:41Z',
      exit_code: 0,
      has_output: true,
      validation: 'ok',
    }),
  };
  for (const [rel, doc] of Object.entries(files))
    writeFileSync(join(run, rel), JSON.stringify(doc));
  // meta.json is a copy of the latest call and must not be counted twice.
  writeFileSync(join(run, 'meta.json'), JSON.stringify(files['meta.review.json']));

  const dry = migrateState(id, { dryRun: true, now: later(1000) });
  expect(dry.attempts).toEqual({ impl: 1, 'spec-test': 1, code: 0 });
  expect(() => readState(id)).toThrow(/old shape/);
  const migrated = migrateState(id, { now: later(1000) });
  expect(migrated).toMatchObject({
    state: 'blocked',
    attempts: { impl: 1, 'spec-test': 1, code: 0 },
    last_error: '/runs/B9-01a/r2-fix-input.txt',
    uncounted_calls: [
      { kind: 'spec-test', started_at: '2026-10-02T03:14:01Z', exit_code: 124, reason: 'timeout' },
    ],
  });
  expect(readState(id)).toEqual(migrated);
  // Running it again is a no-op; the second spec-test round is still available.
  expect(migrateState(id, { now: later(2000) })).toEqual(migrated);
  expect(bumpAttempt(id, 'spec-test', later(3000)).attempts['spec-test']).toBe(2);
  removeDir(stateFile(id));
  removeDir(run);
});

/** Writes finished calls of a task as the wrapper archives them: attempts/<n>/meta.json. */
function writeCalls(id: string, outcomes: ('ok' | 'none' | 'capacity' | 'invalid')[]): void {
  const dir = join(runs, id, 'attempts');
  outcomes.forEach((o, i) => {
    mkdirSync(join(dir, String(i + 1)), { recursive: true });
    const started = new Date(T0.getTime() + i * 60_000).toISOString();
    const doc = {
      mode: i % 2 === 0 ? 'impl' : 'review',
      review_type: i % 2 === 0 ? null : 'general',
      task: id,
      started_at: started,
      finished_at: started,
      exit_code: { ok: 0, none: 124, capacity: 11, invalid: 10 }[o],
      has_output: o === 'ok',
      idle_killed: false,
      validation: { ok: 'ok', none: 'not-run', capacity: 'not-run', invalid: 'failed' }[o],
    };
    writeFileSync(join(dir, String(i + 1), 'meta.json'), JSON.stringify(doc));
  });
}

it('[规划/11 §2.5] per-task failure breakers: 10 calls, 3 in a row without output', () => {
  // Owner 2026-10-02 (ops/approvals.yaml id 15): no quota gate, only these failure breakers.
  expect(MAX_CALLS_PER_TASK).toBe(10);
  expect(MAX_CONSECUTIVE_NO_OUTPUT).toBe(3);
  expect(taskCalls('D1-01')).toEqual({
    task: 'D1-01',
    calls: 0,
    consecutive_no_output: 0,
    reasons: [],
  });

  // Capacity errors neither extend nor end a run of calls without output; an answer that failed
  // validation is output and ends it.
  writeCalls('D1-02', ['ok', 'none', 'capacity', 'none']);
  expect(taskCalls('D1-02')).toMatchObject({ calls: 4, consecutive_no_output: 2, reasons: [] });
  writeCalls('D1-02', ['ok', 'none', 'capacity', 'none', 'invalid']);
  expect(taskCalls('D1-02').consecutive_no_output).toBe(0);
  writeCalls('D1-02', ['ok', 'none', 'capacity', 'none', 'invalid', 'none', 'none', 'none']);
  const silent = taskCalls('D1-02');
  expect(silent.consecutive_no_output).toBe(3);
  expect(silent.reasons.map((r) => r.breaker)).toEqual(['no_output']);
  expect(silent.reasons[0]?.message).toContain('D1-02: 连续 3 次调用没有产出');
  // The breaker stops only this task, before anything is counted.
  updateState('D1-02', { state: 'doing' }, T0);
  expect(() => bumpAttempt('D1-02', 'impl', T0)).toThrow(/连续 3 次调用没有产出/);
  expect(readState('D1-02')?.attempts.impl).toBe(0);
  expect(bumpAttempt('D1-03', 'impl', T0).attempts.impl).toBe(1);

  // Every finished call counts towards the cap of 10, also calls that gave their round back.
  writeCalls('D1-04', ['ok', 'none', 'ok', 'capacity', 'ok', 'none', 'ok', 'capacity', 'ok']);
  expect(taskCalls('D1-04')).toMatchObject({ calls: 9, reasons: [] });
  expect(bumpAttempt('D1-04', 'code', T0).attempts.code).toBe(1);
  writeCalls('D1-04', ['ok', 'none', 'ok', 'capacity', 'ok', 'none', 'ok', 'capacity', 'ok', 'ok']);
  const capped = taskCalls('D1-04');
  expect(capped.reasons.map((r) => r.breaker)).toEqual(['task_calls']);
  expect(capped.reasons[0]?.message).toContain('达到每任务上限 10 次');
  expect(() => bumpAttempt('D1-04', 'code', T0)).toThrow(/每任务上限 10 次/);
  expect(readState('D1-04')?.attempts.code).toBe(1);
  for (const id of ['D1-02', 'D1-03', 'D1-04']) {
    removeDir(stateFile(id));
    removeDir(join(runs, id));
  }
});

it('refuses to guess when counted review rounds left no meta.json', () => {
  const id = 'B9-02a';
  writeFileSync(
    stateFile(id),
    JSON.stringify({
      id,
      state: 'review',
      attempts: { impl: 1, review: 1 },
      spec_commit: null,
      pid: null,
      started_at: null,
      owner_session: null,
      lease_until: null,
      ask_created_at: null,
      last_error: null,
      updated_at: T0.toISOString(),
    }),
  );
  expect(() => migrateState(id, { now: T0 })).toThrow(/--unattributed-review/);
  expect(migrateState(id, { now: T0, unattributedReview: 'code' }).attempts).toEqual({
    impl: 1,
    'spec-test': 0,
    code: 1,
  });
  removeDir(stateFile(id));
});

it('lets one session claim a task, with a 20 minute lease that can be renewed', () => {
  const claimed = claimTask('A1-04', { owner: 'session-a', now: T0 });
  expect(claimed.owner_session).toBe('session-a');
  expect(claimed.lease_until).toBe(later(LEASE_MS).toISOString());
  expect(existsSync(claimDir('A1-04'))).toBe(true);
  expect(() => claimTask('A1-04', { owner: 'session-b', now: later(1000) })).toThrow(
    /already claimed by session-a/,
  );
  // Even the same session must renew explicitly.
  expect(() => claimTask('A1-04', { owner: 'session-a', now: later(1000) })).toThrow(
    /already claimed/,
  );
  const renewed = claimTask('A1-04', { owner: 'session-a', renew: true, now: later(600_000) });
  expect(renewed.lease_until).toBe(later(600_000 + LEASE_MS).toISOString());
  expect(() => claimTask('A1-04', { owner: 'session-b', renew: true, now: T0 })).toThrow(
    /no claim held by session-b/,
  );
});

it('hands an expired claim to another session and releases claims', () => {
  claimTask('A1-05', { owner: 'session-a', now: T0 });
  expect(() => claimTask('A1-05', { owner: 'session-b', now: later(LEASE_MS) })).toThrow();
  const taken = claimTask('A1-05', { owner: 'session-b', now: later(LEASE_MS + 1000) });
  expect(taken.owner_session).toBe('session-b');
  expect(() => releaseTask('A1-05', { owner: 'session-a', now: later(LEASE_MS + 2000) })).toThrow(
    /claim is held by session-b/,
  );
  const released = releaseTask('A1-05', { owner: 'session-b', now: later(LEASE_MS + 3000) });
  expect(released).toMatchObject({ owner_session: null, lease_until: null, pid: null });
  expect(existsSync(claimDir('A1-05'))).toBe(false);
  expect(
    claimTask('A1-05', { owner: 'session-a', now: later(LEASE_MS + 4000) }).owner_session,
  ).toBe('session-a');
});

it('lists every state file and rejects a damaged one', () => {
  expect(listStates().map((s) => s.id)).toEqual([
    'A1-01',
    'A1-02',
    'A1-03',
    'A1-04',
    'A1-05',
    'A1-07',
    'A1-08',
  ]);
  writeFileSync(stateFile('A1-06'), JSON.stringify({ id: 'A1-06', state: 'flying' }));
  expect(() => readState('A1-06')).toThrow(/state must be one of/);
  writeFileSync(stateFile('A1-06'), '{ not json');
  expect(() => listStates()).toThrow(/invalid JSON/);
  removeDir(stateFile('A1-06'));
});

it(
  'follows the exit code convention on the command line',
  () => {
    const env = { COULI_RUNS: runs };
    expect(runCli('state.ts', ['get', 'C1-01'], env).status).toBe(1);
    expect(runCli('state.ts', ['claim', 'C1-01', '--owner', 's1'], env).status).toBe(0);
    const second = runCli('state.ts', ['claim', 'C1-01', '--owner', 's2'], env);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already claimed by s1');
    expect(runCli('state.ts', ['claim', 'C1-01', '--owner', 's1', '--renew'], env).status).toBe(0);
    for (const n of [1, 2, 3]) {
      const res = runCli('state.ts', ['bump-attempt', 'C1-01', 'impl'], env);
      expect(JSON.parse(res.stdout)).toMatchObject({ attempts: { impl: n } });
    }
    expect(runCli('state.ts', ['bump-attempt', 'C1-01', 'impl'], env).status).toBe(1);
    const set = runCli(
      'state.ts',
      ['set', 'C1-01', '--state', 'verify', '--spec-commit', 'abc1234', '--last-error', 'none'],
      env,
    );
    expect(JSON.parse(set.stdout)).toMatchObject({ state: 'verify', spec_commit: 'abc1234' });
    expect(JSON.parse(runCli('state.ts', ['get', 'C1-01'], env).stdout)).toMatchObject({
      id: 'C1-01',
      state: 'verify',
      owner_session: 's1',
      attempts: { impl: 3, 'spec-test': 0, code: 0 },
    });
    expect(runCli('state.ts', ['release', 'C1-01', '--owner', 's2'], env).status).toBe(1);
    expect(runCli('state.ts', ['release', 'C1-01', '--owner', 's1'], env).status).toBe(0);
    expect(runCli('state.ts', ['set', 'C1-01', '--state', 'flying'], env).status).toBe(2);
    expect(runCli('state.ts', ['bump-attempt', 'C1-01', 'deploy'], env).status).toBe(2);
    // A review round needs its type: each type has its own counter.
    expect(runCli('state.ts', ['bump-attempt', 'C1-01', 'review'], env).status).toBe(2);
    const spec = runCli(
      'state.ts',
      ['bump-attempt', 'C1-01', 'review', '--review-type', 'spec-test'],
      env,
    );
    expect(JSON.parse(spec.stdout)).toMatchObject({ attempts: { 'spec-test': 1, code: 0 } });
    const money = runCli(
      'state.ts',
      ['bump-attempt', 'C1-01', 'review', '--review-type', 'money'],
      env,
    );
    expect(JSON.parse(money.stdout)).toMatchObject({ attempts: { 'spec-test': 1, code: 1 } });
    const metaFile = join(runs, 'C1-01-meta.json');
    writeFileSync(
      metaFile,
      JSON.stringify({
        mode: 'review',
        review_type: 'money',
        started_at: '2026-10-02T06:00:00Z',
        finished_at: '2026-10-02T06:15:00Z',
        exit_code: 124,
        has_output: false,
        idle_killed: false,
        validation: 'not-run',
      }),
    );
    const settled = runCli('state.ts', ['settle', 'C1-01', '--meta', metaFile], env);
    expect(settled.status).toBe(0);
    expect(JSON.parse(settled.stdout)).toMatchObject({
      kind: 'code',
      counted: false,
      changed: true,
      attempts: { impl: 3, 'spec-test': 1, code: 0 },
    });
    expect(runCli('state.ts', ['get', '../../etc/passwd'], env).status).toBe(2);

    // An open failure breaker refuses the next round with exit 3 and says why.
    writeCalls('C1-02', ['none', 'none', 'none']);
    const stopped = runCli('state.ts', ['bump-attempt', 'C1-02', 'impl'], env);
    expect(stopped.status).toBe(3);
    expect(stopped.stderr).toContain('C1-02: 连续 3 次调用没有产出');
    expect(existsSync(stateFile('C1-02'))).toBe(false);
    removeDir(join(runs, 'C1-02'));
  },
  CLI_TIMEOUT,
);
