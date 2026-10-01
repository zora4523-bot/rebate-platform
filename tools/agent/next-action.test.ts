// Tests for next-action.ts: the decision table of post-run.sh (规划/11 §2.3 step 6, §2.5).
import { expect, it } from 'vitest';
import { backoffMinutes, failed, type Input, nextAction } from './next-action.ts';

const OK_GUARD = {
  exit: 0,
  report: { ok: true, violations: [], out_of_scope_ops_docs: [], protected_hits: [] },
};
const OK_PROTECTED = {
  exit: 0,
  report: { ok: true, hits: [], class1: [], class2: [], class3: [] },
};

function implOutput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_done: true,
    files_changed: ['apps/api/src/modules/ledger/post.ts'],
    commands: [],
    tests_passed: true,
    deps_needed: [],
    outside_needed: [],
    blocked_reason: '',
    notes: '',
    ...extra,
  };
}

function input(extra: Partial<Input> = {}, meta: Record<string, unknown> = {}): Input {
  return {
    task: 'B2-02a',
    run: '/runs/B2-02a',
    meta: { mode: 'impl', exit_code: 0, worktree: '/runs/worktrees/B2-02a', ...meta },
    attempts: 1,
    base: 'abc1234',
    impl: implOutput(),
    pathGuard: OK_GUARD,
    protectedPaths: OK_PROTECTED,
    ...extra,
  };
}

it('backoff is 15, 30, 60 minutes by attempt', () => {
  expect([0, 1, 2, 3, 7].map(backoffMinutes)).toEqual([15, 15, 30, 60, 60]);
});

it('usable output with clean guards goes to verification', () => {
  expect(nextAction(input())).toEqual({
    action: 'verify',
    task: 'B2-02a',
    run: '/runs/B2-02a',
    attempt: 1,
    base: 'abc1234',
    worktree: '/runs/worktrees/B2-02a',
    verify: 'tools/ops/verify-container.sh B2-02a',
    revert_first: [],
    outside_needed: [],
  });
});

it('out-of-scope ops/docs changes and outside commands are handed to the orchestrator', () => {
  const action = nextAction(
    input({
      pathGuard: {
        exit: 0,
        report: { ...OK_GUARD.report, out_of_scope_ops_docs: ['docs/notes.md'] },
      },
      impl: implOutput({ outside_needed: [{ cmd: 'pnpm db:migrate', reason: 'new migration' }] }),
    }),
  );
  expect(action).toMatchObject({
    action: 'verify',
    revert_first: ['docs/notes.md'],
    outside_needed: [{ cmd: 'pnpm db:migrate', reason: 'new migration' }],
  });
});

it('protected class 2 or 3 hits always go to the owner', () => {
  const hit3 = { path: 'tools/guard/run.ts', class: 3 };
  const hit2 = { path: 'turbo.json', class: 2 };
  const fromProtected = nextAction(
    input({
      protectedPaths: {
        exit: 1,
        report: { ok: false, hits: [hit3, { path: 'test/spec/a.test.ts', class: 1 }] },
      },
    }),
  );
  // A class 1 hit next to a gate hit is out of bounds, not a question for the owner.
  expect(fromProtected).toMatchObject({
    action: 'retry',
    reason: 'out-of-bounds',
    protected_class1: [{ path: 'test/spec/a.test.ts', class: 1 }],
    protected_gate_hits: [hit3],
  });
  const gateOnly = nextAction(
    input({ protectedPaths: { exit: 1, report: { ok: false, hits: [hit3] } } }),
  );
  expect(gateOnly).toMatchObject({
    action: 'ask',
    reason: 'protected-path',
    hits: [hit3],
    violations: [],
    protected_class1: [],
    out_of_scope_ops_docs: [],
  });
  const fromPathGuard = nextAction(
    input({
      pathGuard: { exit: 1, report: { ok: false, violations: [], protected_hits: [hit2, hit2] } },
    }),
  );
  expect(fromPathGuard).toMatchObject({ action: 'ask', hits: [hit2] });
  // An out-of-bounds change in the same diff is never swallowed by the question.
  const violation = { path: 'apps/api/src/modules/ledger/x.ts', reason: 'outside task paths' };
  const mixed = nextAction(
    input({
      pathGuard: {
        exit: 1,
        report: { ok: false, violations: [violation], protected_hits: [hit2] },
      },
      protectedPaths: { exit: 1, report: { ok: false, hits: [hit2] } },
    }),
  );
  expect(mixed).toMatchObject({
    action: 'retry',
    reason: 'out-of-bounds',
    violations: [violation],
    protected_gate_hits: [hit2],
  });
  // Even on the last attempt: the owner decides, the task is not simply blocked.
  expect(
    nextAction(input({ attempts: 3, protectedPaths: { exit: 1, report: { hits: [hit3] } } }))
      .action,
  ).toBe('ask');
});

it('changes outside the task paths are a failed attempt', () => {
  const violation = { path: 'apps/api/src/modules/payout/x.ts', reason: 'outside task paths' };
  const guard = { exit: 1, report: { ok: false, violations: [violation], protected_hits: [] } };
  expect(nextAction(input({ pathGuard: guard }))).toMatchObject({
    action: 'retry',
    reason: 'out-of-bounds',
    backoff_min: 15,
    violations: [violation],
  });
  expect(nextAction(input({ pathGuard: guard, attempts: 2 }))).toMatchObject({
    action: 'retry',
    backoff_min: 30,
  });
  expect(nextAction(input({ pathGuard: guard, attempts: 3 }))).toMatchObject({
    action: 'blocked',
    reason: 'attempts-exhausted',
    last_failure: 'out-of-bounds',
  });
  // Changed or deleted rule tests (class 1) are out of bounds as well.
  const class1 = {
    exit: 1,
    report: { ok: false, hits: [{ path: 'test/spec/a.test.ts', class: 1 }] },
  };
  expect(nextAction(input({ protectedPaths: class1 }))).toMatchObject({
    action: 'retry',
    reason: 'out-of-bounds',
    protected_class1: [{ path: 'test/spec/a.test.ts', class: 1 }],
  });
});

it('a guard that did not run or crashed never leads to verification', () => {
  expect(nextAction(input({ pathGuard: null }))).toMatchObject({
    action: 'blocked',
    reason: 'guards-not-run',
  });
  expect(nextAction(input({ base: null }))).toMatchObject({
    action: 'blocked',
    reason: 'guards-not-run',
  });
  expect(nextAction(input({ protectedPaths: { exit: 2, report: null } }))).toMatchObject({
    action: 'blocked',
    reason: 'guard-error',
    guard: 'protected-paths',
  });
  expect(nextAction(input({ pathGuard: { exit: 0, report: null } }))).toMatchObject({
    action: 'blocked',
    reason: 'guard-error',
    guard: 'path-guard',
  });
});

it('the implementer account decides between blocked, retry and verify', () => {
  const deps = [{ name: 'zod', version: '4.6.5', reason: 'config validation' }];
  expect(nextAction(input({ impl: implOutput({ deps_needed: deps }) }))).toMatchObject({
    action: 'blocked',
    reason: 'deps-needed',
    deps_needed: deps,
  });
  expect(
    nextAction(input({ impl: implOutput({ task_done: false, blocked_reason: 'BR conflict' }) })),
  ).toMatchObject({
    action: 'blocked',
    reason: 'implementer-blocked',
    blocked_reason: 'BR conflict',
  });
  expect(nextAction(input({ impl: implOutput({ task_done: false }) }))).toMatchObject({
    action: 'retry',
    reason: 'not-done',
  });
  expect(nextAction(input({ impl: null }))).toMatchObject({
    action: 'blocked',
    reason: 'output-missing',
  });
});

it('failed runs are retried with backoff until the attempts are used up', () => {
  expect(
    nextAction(input({}, { exit_code: 10, codex_exit: 1, validation: 'not-run' })),
  ).toMatchObject({
    action: 'retry',
    reason: 'no-usable-output',
    backoff_min: 15,
    codex_exit: 1,
  });
  expect(nextAction(input({ attempts: 2 }, { exit_code: 124, timed_out: true }))).toMatchObject({
    action: 'retry',
    reason: 'timeout',
    backoff_min: 30,
  });
  expect(nextAction(input({}, { exit_code: 124, idle_killed: true })).reason).toBe(
    'inactivity-kill',
  );
  expect(nextAction(input({ attempts: 3 }, { exit_code: 10 }))).toMatchObject({
    action: 'blocked',
    reason: 'attempts-exhausted',
    last_failure: 'no-usable-output',
  });
  expect(failed({ task: 'B2-02a', run: '/r', attempts: 1 }, 'orphan', { detail: 'x' })).toEqual({
    action: 'retry',
    task: 'B2-02a',
    run: '/r',
    reason: 'orphan',
    attempt: 1,
    detail: 'x',
    backoff_min: 15,
  });
});

it('a capacity error is retried without counting, a position failure blocks', () => {
  expect(nextAction(input({ attempts: 3 }, { exit_code: 11, capacity_error: true }))).toMatchObject(
    {
      action: 'capacity-retry',
      counts_as_attempt: false,
      backoff_min: 60,
    },
  );
  expect(nextAction(input({}, { exit_code: 12, position_changed: ['head', 'index'] }))).toEqual({
    action: 'blocked',
    task: 'B2-02a',
    run: '/runs/B2-02a',
    reason: 'position-assertion',
    attempt: 1,
    position_changed: ['head', 'index'],
  });
});

it('an unfinished meta.json is an error, not a decision', () => {
  expect(() => nextAction(input({}, { exit_code: null }))).toThrow(/not finished/);
});
