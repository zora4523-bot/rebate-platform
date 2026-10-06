// Tests for dispatch.sh and post-run.sh (规划/11 §2.2, §2.3 steps 5-6, §2.5). The CLIs of other
// packages (tools/ops, tools/guard) are stubs under a fixture trusted root; Codex is the fake.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  type Fixture,
  gitIn,
  isAlive,
  makeFixture,
  observed,
  observedArgv,
  readJson,
  runScript,
  type StubRule,
  stubCalls,
  TASK,
  writeStub,
} from './testing/fixture.ts';

const LONG = { timeout: 60_000 };
const STUB_STARTED_AT = '2026-10-01T00:00:00Z';
const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fx of fixtures.splice(0)) fx.cleanup();
});

type Stubs = {
  state?: StubRule[];
  brief?: StubRule[];
  task?: StubRule[];
  pathGuard?: StubRule[];
  protectedPaths?: StubRule[];
};

function stateJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: TASK,
    state: 'doing',
    attempts: { impl: 1, 'spec-test': 0, code: 0 },
    spec_commit: null,
    pid: null,
    ...extra,
  });
}

const PATH_GUARD_OK = JSON.stringify({
  ok: true,
  violations: [],
  out_of_scope_ops_docs: [],
  protected_hits: [],
});
const PROTECTED_OK = JSON.stringify({ ok: true, hits: [], class1: [], class2: [], class3: [] });

function fixture(name: string, stubs: Stubs = {}): Fixture {
  const fx = makeFixture(name);
  fixtures.push(fx);
  const ops = join(fx.trusted, 'tools', 'ops');
  const guard = join(fx.trusted, 'tools', 'guard');
  // Token accounting only: dispatch.sh never asks it anything (no quota gate, 规划/11 §1.3).
  writeStub(join(ops, 'usage.ts'), 'usage');
  writeStub(
    join(ops, 'state.ts'),
    'state',
    stubs.state ?? [{ when: ['get'], stdout: stateJson() }],
  );
  writeStub(
    join(ops, 'brief.ts'),
    'brief',
    stubs.brief ?? [{ writeOut: `# 任务 ${TASK}：stub brief\n\n- 本轮阶段：test（stub）\n` }],
  );
  writeStub(
    join(ops, 'task.ts'),
    'task',
    stubs.task ?? [
      {
        when: ['show'],
        stdout: JSON.stringify({
          id: TASK,
          type: 'impl',
          risk: 'RV1',
          tester: 'codex',
          test_paths: ['test/spec/fixture/**'],
        }),
      },
    ],
  );
  writeStub(
    join(guard, 'path-guard.ts'),
    'path-guard',
    stubs.pathGuard ?? [{ stdout: PATH_GUARD_OK }],
  );
  writeStub(
    join(guard, 'protected-paths.ts'),
    'protected-paths',
    stubs.protectedPaths ?? [{ stdout: PROTECTED_OK }],
  );
  mkdirSync(join(fx.worktree, 'node_modules'));
  fx.env['COULI_SESSION'] = 'sess-test';
  return fx;
}

function lastJsonLine(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as Record<string, unknown>;
}

/** Waits until the background wrapper started by dispatch.sh has finished its meta.json. */
function waitForRun(fx: Fixture): Record<string, unknown> {
  const file = join(fx.run, 'meta.impl.json');
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        const meta = readJson(file);
        // writeMeta() uses a fixed start time; only a meta written by the wrapper counts.
        if (typeof meta['finished_at'] === 'string' && meta['started_at'] !== STUB_STARTED_AT) {
          // The wrapper still records its usage after this point: wait for it to exit, so
          // that nothing runs when the fixture is removed.
          while (isAlive(Number(meta['wrapper_pid'])) && Date.now() < deadline) {
            spawnSync('sleep', ['0.1']);
          }
          return meta;
        }
      } catch {
        // being replaced; read again
      }
    }
    spawnSync('sleep', ['0.1']);
  }
  throw new Error(
    `background run did not finish: ${readFileSync(join(fx.run, 'dispatch.log'), 'utf8')}`,
  );
}

function writeMeta(fx: Fixture, fields: Record<string, unknown>): void {
  const meta = {
    mode: 'impl',
    task: TASK,
    worktree: fx.worktree,
    run: fx.run,
    started_at: STUB_STARTED_AT,
    finished_at: '2026-10-01T00:05:00Z',
    exit_code: 0,
    codex_exit: 0,
    timed_out: false,
    idle_killed: false,
    has_output: true,
    capacity_error: false,
    head_before: fx.baseSha,
    head_after: fx.baseSha,
    pgid: 0,
    group_gone: true,
    wrapper_pid: 0,
    position_changed: [],
    ...fields,
  };
  writeFileSync(join(fx.run, 'meta.impl.json'), JSON.stringify(meta));
}

function writeImpl(fx: Fixture, extra: Record<string, unknown> = {}): void {
  const impl = {
    task_done: true,
    files_changed: ['src/a.ts'],
    commands: [],
    tests_passed: true,
    deps_needed: [],
    outside_needed: [],
    blocked_reason: '',
    notes: '',
    ...extra,
  };
  writeFileSync(join(fx.run, 'impl.json'), JSON.stringify(impl));
}

/** A pid that no longer exists. */
function deadPid(): number {
  const res = spawnSync(process.execPath, ['-e', '']);
  return res.pid;
}

it('dispatch: preflight in order, background launch, pid recorded', LONG, () => {
  const fx = fixture('dispatch-ok');
  const res = runScript('dispatch.sh', [TASK], fx.env);
  expect(res.status, res.stderr).toBe(0);
  const out = lastJsonLine(res.stdout);
  expect(Object.keys(out)).toEqual(['action', 'pid', 'run', 'phase']);
  // Codex writes the rule tests by default (ops/approvals.yaml id 19).
  expect(out).toMatchObject({ action: 'dispatched', run: fx.run, phase: 'test' });
  const pid = Number(out['pid']);
  expect(pid).toBeGreaterThan(1);

  const meta = waitForRun(fx);
  expect(meta).toMatchObject({ mode: 'impl', exit_code: 0, has_output: true });
  // The wrapper records its usage after meta.json is complete: wait until it has exited.
  const deadline = Date.now() + 20_000;
  while (isAlive(pid) && Date.now() < deadline) spawnSync('sleep', ['0.1']);
  expect(isAlive(pid)).toBe(false);
  expect(observed(fx)).toMatchObject({ wrapper: '1', stdin: 'devnull' });

  const calls = stubCalls(fx);
  // No quota gate (owner 2026-10-02, ops/approvals.yaml id 15): the claim comes first, and the
  // usage ledger is only written by the wrapper after the call.
  expect(calls.slice(0, 4)).toEqual([
    ['state', 'claim', TASK, '--owner', 'sess-test'],
    // The pid of a still-running previous dispatch is looked up before anything is counted.
    ['state', 'get', TASK],
    // The ledger must name the task's test_paths (CR-06).
    ['task', 'show', TASK, '--json'],
    // Codex writing tests has its own counter, never the implementation's (RO-07).
    ['state', 'bump-attempt', TASK, 'test'],
  ]);
  expect(calls.filter((call) => call[0] === 'usage' && call[1] !== 'record')).toEqual([]);
  const set = calls.find((call) => call[0] === 'state' && call[1] === 'set');
  expect(set?.slice(0, 7)).toEqual([
    'state',
    'set',
    TASK,
    '--state',
    'doing',
    '--pid',
    String(pid),
  ]);
  expect(set?.[7]).toBe('--started-at');
  expect(Date.parse(set?.[8] ?? '')).not.toBeNaN();
  // The brief was already there: brief.ts is not called; the wrapper recorded its usage.
  expect(calls.some((call) => call[0] === 'brief')).toBe(false);
  expect(calls).toContainEqual([
    'usage',
    'record',
    '--run',
    fx.run,
    '--task',
    TASK,
    '--mode',
    'impl',
  ]);
});

it('dispatch: an open failure breaker stops the task with exit 3 and says why', LONG, () => {
  // 规划/11 §2.5: 10 calls per task, or 3 calls in a row without output (state.ts bump-attempt).
  const why = `${TASK}: 连续 3 次调用没有产出（规划/11 §2.5）；停止该任务并报告`;
  const fx = fixture('dispatch-breaker', {
    state: [
      { when: ['bump-attempt'], exit: 3, stderr: why },
      { when: ['get'], stdout: stateJson() },
    ],
  });
  const res = runScript('dispatch.sh', [TASK], fx.env);
  expect(res.status, res.stderr).toBe(3);
  expect(lastJsonLine(res.stdout)).toEqual({
    action: 'stopped',
    task: TASK,
    reason: 'task-breaker',
    detail: why,
  });
  expect(stubCalls(fx).map((call) => call.slice(0, 2).join(' '))).toEqual([
    'state claim',
    'state get',
    'task show',
    'state bump-attempt',
  ]);
  expect(existsSync(join(fx.run, 'dispatch.log'))).toBe(false);
});

it(
  'dispatch: a task claimed by someone else is not dispatched; an own claim is renewed',
  LONG,
  () => {
    // Claimed by another session: no renewal is even attempted on somebody else's claim.
    const foreign = fixture('dispatch-claimed', {
      state: [
        { when: ['claim'], exit: 1 },
        { when: ['get'], stdout: stateJson({ owner_session: 'sess-other' }) },
      ],
    });
    const refused = runScript('dispatch.sh', [TASK], foreign.env);
    expect(refused.status, refused.stderr).toBe(1);
    expect(lastJsonLine(refused.stdout)).toMatchObject({ action: 'none', reason: 'claim-failed' });
    expect(stubCalls(foreign, 'state')).toEqual([
      ['state', 'claim', TASK, '--owner', 'sess-test'],
      ['state', 'get', TASK],
    ]);

    // Claimed by this very session (same COULI_SESSION): renewed.
    const own = fixture('dispatch-renew', {
      state: [
        { when: ['claim', '--renew'], exit: 0 },
        { when: ['claim'], exit: 1 },
        { when: ['get'], stdout: stateJson({ owner_session: 'sess-test' }) },
      ],
    });
    const renewed = runScript('dispatch.sh', [TASK], own.env);
    expect(renewed.status, renewed.stderr).toBe(0);
    expect(lastJsonLine(renewed.stdout)['action']).toBe('dispatched');
    expect(stubCalls(own, 'state').slice(0, 2)).toEqual([
      ['state', 'claim', TASK, '--owner', 'sess-test'],
      ['state', 'get', TASK],
    ]);
    expect(stubCalls(own, 'state')[2]).toEqual([
      'state',
      'claim',
      TASK,
      '--renew',
      '--owner',
      'sess-test',
    ]);
    waitForRun(own);

    // Without COULI_SESSION the owner is unique to the dispatch process, so a claim that is
    // still held is never renewed by a later dispatch.
    const anonymous = fixture('dispatch-anonymous', {
      state: [
        { when: ['claim'], exit: 1 },
        { when: ['get'], stdout: stateJson({ owner_session: 'orchestrator' }) },
      ],
    });
    delete anonymous.env['COULI_SESSION'];
    const again = runScript('dispatch.sh', [TASK], anonymous.env);
    expect(again.status, again.stderr).toBe(1);
    expect(lastJsonLine(again.stdout)).toMatchObject({ action: 'none', reason: 'claim-failed' });
    expect(stubCalls(anonymous, 'state')[0]?.[4]).toMatch(/^orchestrator-[A-Za-z0-9._-]+-\d+$/);
  },
);

it('dispatch: a run that is still alive, or a dispatch in progress, is not doubled', LONG, () => {
  const alive = fixture('dispatch-alive', {
    state: [{ when: ['get'], stdout: stateJson({ pid: process.pid }) }],
  });
  const res = runScript('dispatch.sh', [TASK], alive.env);
  expect(res.status, res.stderr).toBe(1);
  expect(lastJsonLine(res.stdout)).toMatchObject({ action: 'none', reason: 'run-in-progress' });
  expect(stubCalls(alive, 'state').map((c) => c[1])).toEqual(['claim', 'get']);
  expect(existsSync(join(alive.run, 'dispatch.lock'))).toBe(false);

  const locked = fixture('dispatch-locked');
  mkdirSync(join(locked.run, 'dispatch.lock'));
  const second = runScript('dispatch.sh', [TASK], locked.env);
  expect(second.status, second.stderr).toBe(1);
  expect(lastJsonLine(second.stdout)).toMatchObject({
    action: 'none',
    reason: 'dispatch-in-progress',
  });
  expect(stubCalls(locked)).toEqual([]);
});

it('dispatch: used-up attempts stop the launch', LONG, () => {
  const fx = fixture('dispatch-exhausted', {
    state: [{ when: ['bump-attempt'], exit: 1 }],
  });
  const res = runScript('dispatch.sh', [TASK], fx.env);
  expect(res.status, res.stderr).toBe(1);
  expect(lastJsonLine(res.stdout)).toMatchObject({ action: 'none', reason: 'attempts-exhausted' });
  expect(existsSync(join(fx.run, 'dispatch.log'))).toBe(false);
});

it('dispatch: a missing brief is generated; missing dependencies are never installed', LONG, () => {
  const fx = fixture('dispatch-brief');
  rmSync(join(fx.run, 'brief.md'));
  rmSync(join(fx.worktree, 'node_modules'), { recursive: true });
  const res = runScript('dispatch.sh', [TASK], fx.env);
  expect(res.status, res.stderr).toBe(1);
  expect(lastJsonLine(res.stdout)).toMatchObject({
    action: 'none',
    reason: 'node-modules-missing',
  });
  expect(readFileSync(join(fx.run, 'brief.md'), 'utf8')).toContain('stub brief');
  // The attempt was counted before the brief and the worktree were looked at.
  expect(stubCalls(fx).map((call) => call.slice(0, 2).join(' '))).toEqual([
    'state claim',
    'state get',
    'task show',
    'state bump-attempt',
    'state get',
    `brief ${TASK}`,
  ]);
  expect(existsSync(join(fx.worktree, 'node_modules'))).toBe(false);
  expect(existsSync(join(fx.run, 'dispatch.log'))).toBe(false);

  rmSync(join(fx.worktree), { recursive: true });
  const noWorktree = runScript('dispatch.sh', [TASK], fx.env);
  expect(noWorktree.status).toBe(1);
  expect(lastJsonLine(noWorktree.stdout)).toMatchObject({ reason: 'worktree-missing' });
});

it('dispatch: from the second attempt on the brief is regenerated before the launch', LONG, () => {
  // 规划/11 §2.3: a retry is a new round that carries the previous failure output; brief.ts
  // takes both the attempt number and that output from the in-flight state.
  const fx = fixture('dispatch-retry-brief', {
    state: [
      {
        when: ['get'],
        stdout: stateJson({
          attempts: { test: 2, impl: 0, handover: 0, 'spec-test': 0, code: 0 },
        }),
      },
    ],
    brief: [
      { writeOut: `# 任务 ${TASK}：regenerated for attempt 2\n\n- 本轮阶段：test（stub）\n` },
    ],
  });
  expect(readFileSync(join(fx.run, 'brief.md'), 'utf8')).toContain('fixture task');
  const res = runScript('dispatch.sh', [TASK], fx.env);
  expect(res.status, res.stderr).toBe(0);
  waitForRun(fx);
  expect(readFileSync(join(fx.run, 'brief.md'), 'utf8')).toContain('regenerated for attempt 2');
  const order = stubCalls(fx).map((call) => call.slice(0, 2).join(' '));
  expect(order.indexOf(`brief ${TASK}`)).toBeGreaterThan(order.indexOf('state bump-attempt'));
  // Codex was given the regenerated brief, not the stale one.
  expect(observedArgv(fx).at(-1)).toContain('regenerated for attempt 2');
});

it(
  '[规划/11 §2.5] dispatch always counts; the wrapper gives a call without output back',
  LONG,
  () => {
    const fx = fixture('dispatch-capacity');
    // The previous call ended with a capacity error; codex-run.sh settled it back then.
    writeMeta(fx, { exit_code: 11, capacity_error: true, has_output: false });
    const res = runScript('dispatch.sh', [TASK], fx.env);
    expect(res.status, res.stderr).toBe(0);
    waitForRun(fx);
    const stateCalls = stubCalls(fx, 'state').map((call) => call.slice(1, 3).join(' '));
    expect(stateCalls).toContain(`bump-attempt ${TASK}`);
    // The new call is settled by the wrapper when it finishes, after the bump.
    expect(stateCalls.indexOf(`settle ${TASK}`)).toBeGreaterThan(
      stateCalls.indexOf(`bump-attempt ${TASK}`),
    );
    expect(readJson(join(fx.run, 'attempts', '1', 'meta.json'))['exit_code']).toBe(11);
  },
);

it('dispatch: bad usage is exit 2', LONG, () => {
  const fx = fixture('dispatch-usage');
  expect(runScript('dispatch.sh', [], fx.env).status).toBe(2);
  expect(runScript('dispatch.sh', ['../x'], fx.env).status).toBe(2);
  expect(runScript('dispatch.sh', [TASK, 'extra'], fx.env).status).toBe(2);
  expect(stubCalls(fx)).toEqual([]);
});

it(
  'post-run: guards run from the trusted root, then the run is handed to verification',
  LONG,
  () => {
    const fx = fixture('post-verify');
    writeMeta(fx, {});
    writeImpl(fx, { outside_needed: [{ cmd: 'pnpm db:migrate', reason: 'new migration' }] });
    writeFileSync(join(fx.worktree, 'src', 'a.ts'), 'export const a = 2;\n');
    const statusBefore = gitIn(fx.worktree, ['status', '--porcelain']);
    const headBefore = gitIn(fx.worktree, ['rev-parse', 'HEAD']);

    const res = runScript('post-run.sh', [TASK], fx.env);
    expect(res.status, res.stderr).toBe(0);
    expect(lastJsonLine(res.stdout)).toEqual({
      action: 'verify',
      task: TASK,
      run: fx.run,
      attempt: 1,
      base: fx.baseSha,
      worktree: fx.worktree,
      verify: `tools/ops/verify-container.sh ${TASK}`,
      revert_first: [],
      outside_needed: [{ cmd: 'pnpm db:migrate', reason: 'new migration' }],
    });
    expect(stubCalls(fx)).toEqual([
      ['state', 'get', TASK],
      ['task', 'show', TASK, '--json'],
      ['path-guard', '--task', TASK, '--base', fx.baseSha, '--cwd', fx.worktree, '--json'],
      [
        'protected-paths',
        '--base',
        fx.baseSha,
        '--cwd',
        fx.worktree,
        '--json',
        '--task-type',
        'impl',
      ],
    ]);
    // Nothing of the task ran and git state is untouched.
    expect(gitIn(fx.worktree, ['status', '--porcelain'])).toBe(statusBefore);
    expect(gitIn(fx.worktree, ['rev-parse', 'HEAD'])).toBe(headBefore);
  },
);

it('post-run: the rule-test commit is the base of the guards when there is one', LONG, () => {
  const fx = fixture('post-spec-commit');
  writeFileSync(join(fx.worktree, 'src', 'spec.test.ts'), '// rule test\n');
  gitIn(fx.worktree, ['add', '.']);
  gitIn(fx.worktree, ['commit', '-q', '-m', 'test(spec): rule tests']);
  const specCommit = gitIn(fx.worktree, ['rev-parse', 'HEAD']);
  writeStub(join(fx.trusted, 'tools', 'ops', 'state.ts'), 'state', [
    { when: ['get'], stdout: stateJson({ spec_commit: specCommit }) },
  ]);
  writeMeta(fx, {});
  writeImpl(fx);
  const res = runScript('post-run.sh', [TASK], fx.env);
  expect(res.status, res.stderr).toBe(0);
  expect(lastJsonLine(res.stdout)).toMatchObject({ action: 'verify', base: specCommit });
  expect(stubCalls(fx, 'path-guard')[0]).toContain(specCommit);
});

it('post-run: protected class 3 goes to ask, a path violation is a failed attempt', LONG, () => {
  const hit = { path: 'tools/guard/run.ts', class: 3 };
  const ask = fixture('post-ask', {
    protectedPaths: [{ exit: 1, stdout: JSON.stringify({ ok: false, hits: [hit] }) }],
  });
  writeMeta(ask, {});
  writeImpl(ask);
  const asked = runScript('post-run.sh', [TASK], ask.env);
  expect(asked.status, asked.stderr).toBe(0);
  expect(lastJsonLine(asked.stdout)).toMatchObject({
    action: 'ask',
    reason: 'protected-path',
    hits: [hit],
  });

  const violation = { path: 'apps/api/src/other.ts', reason: 'outside task paths' };
  const out = fixture('post-violation', {
    pathGuard: [
      {
        exit: 1,
        stdout: JSON.stringify({ ok: false, violations: [violation], protected_hits: [] }),
      },
    ],
    state: [
      { when: ['get'], stdout: stateJson({ attempts: { impl: 2, 'spec-test': 0, code: 0 } }) },
    ],
  });
  writeMeta(out, {});
  writeImpl(out);
  const retried = runScript('post-run.sh', [TASK], out.env);
  expect(retried.status, retried.stderr).toBe(0);
  expect(lastJsonLine(retried.stdout)).toMatchObject({
    action: 'retry',
    reason: 'out-of-bounds',
    attempt: 2,
    backoff_min: 30,
    violations: [violation],
  });
});

it('post-run: a crashed guard blocks; a missing guard is an error', LONG, () => {
  const fx = fixture('post-guard-error', { pathGuard: [{ exit: 2 }] });
  writeMeta(fx, {});
  writeImpl(fx);
  const res = runScript('post-run.sh', [TASK], fx.env);
  expect(res.status, res.stderr).toBe(0);
  expect(lastJsonLine(res.stdout)).toMatchObject({ action: 'blocked', reason: 'guard-error' });

  rmSync(join(fx.trusted, 'tools', 'guard', 'protected-paths.ts'));
  const missing = runScript('post-run.sh', [TASK], fx.env);
  expect(missing.status).toBe(2);
  expect(missing.stdout).toBe('');
});

it('post-run: failed runs are decided without running any guard', LONG, () => {
  const cases: Array<[Record<string, unknown>, number, Record<string, unknown>]> = [
    [
      { exit_code: 10, has_output: false },
      1,
      { action: 'retry', reason: 'no-usable-output', backoff_min: 15 },
    ],
    [
      { exit_code: 124, timed_out: true },
      2,
      { action: 'retry', reason: 'timeout', backoff_min: 30 },
    ],
    [{ exit_code: 10, has_output: false }, 3, { action: 'blocked', reason: 'attempts-exhausted' }],
    [
      { exit_code: 11, capacity_error: true },
      1,
      { action: 'capacity-retry', counts_as_attempt: false },
    ],
    [
      { exit_code: 12, position_changed: ['head'] },
      1,
      { action: 'blocked', reason: 'position-assertion', position_changed: ['head'] },
    ],
  ];
  for (const [meta, attempts, expected] of cases) {
    const fx = fixture('post-failed', {
      state: [
        {
          when: ['get'],
          stdout: stateJson({ attempts: { impl: attempts, 'spec-test': 0, code: 0 } }),
        },
      ],
    });
    writeMeta(fx, meta);
    const res = runScript('post-run.sh', [TASK], fx.env);
    expect(res.status, res.stderr).toBe(0);
    expect(lastJsonLine(res.stdout)).toMatchObject(expected);
    expect(stubCalls(fx).map((call) => call[0])).toEqual(['state']);
  }
});

it('post-run: a run that is still going on is left alone (exit 1)', LONG, () => {
  const fx = fixture('post-running');
  writeMeta(fx, { finished_at: null, exit_code: null, wrapper_pid: process.pid });
  const res = runScript('post-run.sh', [TASK], fx.env);
  expect(res.status, res.stderr).toBe(1);
  expect(lastJsonLine(res.stdout)).toMatchObject({ action: 'none', reason: 'wrapper-running' });
  expect(stubCalls(fx).map((call) => call[0])).toEqual(['state']);
});

it(
  'post-run: an orphaned Codex group is ended as a whole and counted as a failed attempt',
  LONG,
  () => {
    const fx = fixture('post-orphan');
    // A process group whose "wrapper" is gone: started through a shell that exits at once.
    const started = spawnSync(
      'bash',
      ['-c', `perl -e 'setpgrp(0, 0); exec "sleep", "120"' >/dev/null 2>&1 </dev/null & echo $!`],
      { encoding: 'utf8' },
    );
    const pgid = Number(started.stdout.trim());
    expect(pgid).toBeGreaterThan(1);
    const deadline = Date.now() + 5_000;
    while (!isAlive(pgid) && Date.now() < deadline) spawnSync('sleep', ['0.05']);
    expect(isAlive(pgid)).toBe(true);

    mkdirSync(join(fx.run, 'wrapper-impl'), { recursive: true });
    writeFileSync(join(fx.run, 'wrapper-impl', 'pgid'), `${pgid}\n`);
    writeMeta(fx, { finished_at: null, exit_code: null, wrapper_pid: deadPid() });
    const res = runScript('post-run.sh', [TASK], fx.env);
    expect(res.status, res.stderr).toBe(0);
    expect(isAlive(pgid)).toBe(false);
    expect(lastJsonLine(res.stdout)).toMatchObject({
      action: 'retry',
      reason: 'orphan',
      backoff_min: 15,
    });
  },
);

it('post-run: a wrapper that never started Codex is reported as blocked', LONG, () => {
  const fx = fixture('post-no-meta');
  writeFileSync(join(fx.run, 'dispatch.log'), 'codex-run: worktree not found: /x\n');
  const res = runScript('post-run.sh', [TASK], fx.env);
  expect(res.status, res.stderr).toBe(0);
  expect(lastJsonLine(res.stdout)).toMatchObject({
    action: 'blocked',
    reason: 'wrapper-failed',
    detail: 'codex-run: worktree not found: /x',
  });
  expect(runScript('post-run.sh', [], fx.env).status).toBe(2);
});

it(
  '[ops/approvals.yaml id 19] dispatch: committed rule tests are never rewritten by Codex',
  LONG,
  () => {
    const fx = fixture('dispatch-spec-done', {
      state: [{ when: ['get'], stdout: stateJson({ spec_commit: 'abc1234' }) }],
    });
    const res = runScript('dispatch.sh', [TASK], fx.env);
    expect(res.status, res.stderr).toBe(1);
    expect(lastJsonLine(res.stdout)).toMatchObject({
      action: 'none',
      reason: 'spec-commit-exists',
    });
    expect(String(lastJsonLine(res.stdout)['detail'])).toContain('Claude Opus subagent');
    // Nothing was counted and nothing was launched.
    expect(stubCalls(fx, 'state').some((call) => call[1] === 'bump-attempt')).toBe(false);
    expect(existsSync(join(fx.run, 'dispatch.log'))).toBe(false);
  },
);

it(
  '[规划/11 §2.5] dispatch --handover: RV0 / RV1 only, its own counter and an impl brief',
  LONG,
  () => {
    const rv2 = fixture('dispatch-handover-rv2', {
      task: [{ when: ['show'], stdout: JSON.stringify({ id: TASK, type: 'impl', risk: 'RV2' }) }],
      state: [{ when: ['get'], stdout: stateJson({ spec_commit: 'abc1234' }) }],
    });
    const refused = runScript('dispatch.sh', [TASK, '--handover'], rv2.env);
    expect(refused.status).toBe(1);
    expect(lastJsonLine(refused.stdout)).toMatchObject({ reason: 'handover-refused' });
    expect(stubCalls(rv2, 'state').some((call) => call[1] === 'bump-attempt')).toBe(false);

    const fx = fixture('dispatch-handover', {
      state: [{ when: ['get'], stdout: stateJson({ spec_commit: 'abc1234' }) }],
      brief: [{ writeOut: `# 任务 ${TASK}：handover brief\n\n- 本轮阶段：handover（stub）\n` }],
    });
    const res = runScript('dispatch.sh', [TASK, '--handover'], fx.env);
    expect(res.status, res.stderr).toBe(0);
    expect(lastJsonLine(res.stdout)).toMatchObject({ action: 'dispatched', phase: 'handover' });
    const meta = waitForRun(fx);
    expect(meta).toMatchObject({ mode: 'impl', phase: 'handover', exit_code: 0 });
    const calls = stubCalls(fx);
    expect(calls).toContainEqual(['state', 'bump-attempt', TASK, 'handover']);
    // CR-09: the in-flight state names Codex as the implementer, so its code review goes to Claude.
    const set = calls.find((call) => call[0] === 'state' && call[1] === 'set') ?? [];
    expect(set.slice(-2)).toEqual(['--implementer', 'codex']);
    // The test-phase brief of the fixture is not reused for an implementation.
    expect(calls).toContainEqual([
      'brief',
      TASK,
      '--phase',
      'handover',
      '--out',
      join(fx.run, 'brief.md'),
    ]);
    expect(observedArgv(fx).at(-1)).toContain('handover brief');
  },
);

it(
  'post-run: a Codex rule-test run is guarded as the rule-test author and goes to the red check',
  LONG,
  () => {
    const fx = fixture('post-test-phase', {
      state: [
        {
          when: ['get'],
          stdout: stateJson({
            attempts: { test: 1, impl: 0, handover: 0, 'spec-test': 0, code: 0 },
          }),
        },
      ],
    });
    writeMeta(fx, { phase: 'test' });
    writeImpl(fx);
    const res = runScript('post-run.sh', [TASK], fx.env);
    expect(res.status, res.stderr).toBe(0);
    expect(lastJsonLine(res.stdout)).toMatchObject({
      action: 'red-check',
      phase: 'test',
      attempt: 1,
      base: fx.baseSha,
    });
    expect(stubCalls(fx, 'path-guard')[0]).toEqual([
      'path-guard',
      '--task',
      TASK,
      '--base',
      fx.baseSha,
      '--cwd',
      fx.worktree,
      '--json',
      '--author',
    ]);
  },
);

it(
  '[CR-06] dispatch: a ledger without test_paths gets no test phase and nothing is counted',
  LONG,
  () => {
    const fx = fixture('dispatch-no-test-paths', {
      task: [{ when: ['show'], stdout: JSON.stringify({ id: TASK, type: 'impl', risk: 'RV1' }) }],
    });
    const res = runScript('dispatch.sh', [TASK], fx.env);
    expect(res.status, res.stderr).toBe(1);
    expect(lastJsonLine(res.stdout)).toMatchObject({
      action: 'none',
      reason: 'test-paths-missing',
    });
    expect(stubCalls(fx, 'state').some((call) => call[1] === 'bump-attempt')).toBe(false);
    expect(existsSync(join(fx.run, 'dispatch.log'))).toBe(false);
  },
);

it(
  '[legacy flow] dispatch: a legacy impl: codex ledger is dispatched as the old Codex implementation',
  LONG,
  () => {
    const fx = fixture('dispatch-legacy', {
      task: [
        {
          when: ['show'],
          stdout: JSON.stringify({
            id: TASK,
            type: 'impl',
            risk: 'RV2',
            impl: 'codex',
            tester: 'claude',
          }),
        },
      ],
      state: [{ when: ['get'], stdout: stateJson({ spec_commit: 'abc1234' }) }],
      brief: [{ writeOut: `# 任务 ${TASK}：legacy\n\n- 本轮阶段：impl（旧分工）\n` }],
    });
    mkdirSync(join(fx.trusted, 'tools', 'guard'), { recursive: true });
    writeFileSync(
      join(fx.trusted, 'tools', 'guard', 'legacy-tasks.json'),
      JSON.stringify({ baseline: 'fixture', tasks: [TASK] }),
    );
    const res = runScript('dispatch.sh', [TASK], fx.env);
    expect(res.status, res.stderr).toBe(0);
    expect(lastJsonLine(res.stdout)).toMatchObject({ action: 'dispatched', phase: 'impl' });
    const meta = waitForRun(fx);
    expect(meta).toMatchObject({ mode: 'impl', phase: 'impl', exit_code: 0 });
    const calls = stubCalls(fx);
    // The implementation counter, an implementation brief, no test_paths asked, no handover mark.
    expect(calls).toContainEqual(['state', 'bump-attempt', TASK, 'impl']);
    expect(calls).toContainEqual([
      'brief',
      TASK,
      '--phase',
      'impl',
      '--out',
      join(fx.run, 'brief.md'),
    ]);
    const set = calls.find((call) => call[0] === 'state' && call[1] === 'set') ?? [];
    expect(set).not.toContain('--implementer');
  },
);

it(
  '[CR3-01] dispatch: B1-02b shape (legacy, impl: claude, no test_paths) goes to the test phase',
  LONG,
  () => {
    const fx = fixture('dispatch-legacy-test', {
      task: [
        {
          when: ['show'],
          stdout: JSON.stringify({
            id: TASK,
            type: 'impl',
            risk: 'RV1',
            impl: 'claude',
            tester: 'codex',
          }),
        },
      ],
    });
    mkdirSync(join(fx.trusted, 'tools', 'guard'), { recursive: true });
    writeFileSync(
      join(fx.trusted, 'tools', 'guard', 'legacy-tasks.json'),
      JSON.stringify({ baseline: 'fixture', tasks: [TASK] }),
    );
    const res = runScript('dispatch.sh', [TASK], fx.env);
    expect(res.status, res.stderr).toBe(0);
    expect(lastJsonLine(res.stdout)).toMatchObject({ action: 'dispatched', phase: 'test' });
    expect(waitForRun(fx)).toMatchObject({ mode: 'impl', phase: 'test', exit_code: 0 });
    expect(stubCalls(fx)).toContainEqual(['state', 'bump-attempt', TASK, 'test']);
  },
);

it(
  '[approvals 23] dispatch: a codex-impl-tasks.json ledger (impl: codex, tester: claude) is dispatched as the Codex implementation once spec_commit is set',
  LONG,
  () => {
    const task = [
      {
        when: ['show'],
        stdout: JSON.stringify({
          id: TASK,
          type: 'impl',
          risk: 'RV2',
          impl: 'codex',
          tester: 'claude',
          test_paths: ['test/spec/demo/**'],
        }),
      },
    ];
    const list = (root: string): void => {
      mkdirSync(join(root, 'tools', 'guard'), { recursive: true });
      writeFileSync(
        join(root, 'tools', 'guard', 'codex-impl-tasks.json'),
        JSON.stringify({ approval: 23, tasks: [TASK] }),
      );
    };
    // Without spec_commit Claude's rule tests are not frozen yet: nothing is counted.
    const early = fixture('dispatch-codex-first-early', {
      task,
      state: [{ when: ['get'], stdout: stateJson({}) }],
    });
    list(early.trusted);
    const refused = runScript('dispatch.sh', [TASK], early.env);
    expect(refused.status).toBe(1);
    expect(lastJsonLine(refused.stdout)).toMatchObject({
      action: 'none',
      reason: 'spec-commit-missing',
    });
    expect(stubCalls(early, 'state').some((call) => call[1] === 'bump-attempt')).toBe(false);

    const fx = fixture('dispatch-codex-first', {
      task,
      state: [{ when: ['get'], stdout: stateJson({ spec_commit: 'abc1234' }) }],
      brief: [{ writeOut: `# 任务 ${TASK}：codex first\n\n- 本轮阶段：impl（Codex 首发）\n` }],
    });
    list(fx.trusted);
    const res = runScript('dispatch.sh', [TASK], fx.env);
    expect(res.status, res.stderr).toBe(0);
    expect(lastJsonLine(res.stdout)).toMatchObject({ action: 'dispatched', phase: 'impl' });
    const meta = waitForRun(fx);
    expect(meta).toMatchObject({ mode: 'impl', phase: 'impl', exit_code: 0 });
    const calls = stubCalls(fx);
    expect(calls).toContainEqual(['state', 'bump-attempt', TASK, 'impl']);
    expect(calls).toContainEqual([
      'brief',
      TASK,
      '--phase',
      'impl',
      '--out',
      join(fx.run, 'brief.md'),
    ]);
    const set = calls.find((call) => call[0] === 'state' && call[1] === 'set') ?? [];
    expect(set).not.toContain('--implementer');
    // Already a Codex implementation: no Codex handover on top (S2-7).
    const handover = fixture('dispatch-codex-first-handover', {
      task: [{ when: ['show'], stdout: task[0]!.stdout.replace('"RV2"', '"RV1"') }],
      state: [{ when: ['get'], stdout: stateJson({ spec_commit: 'abc1234' }) }],
    });
    list(handover.trusted);
    const refusedHandover = runScript('dispatch.sh', [TASK, '--handover'], handover.env);
    expect(refusedHandover.status).toBe(1);
    expect(lastJsonLine(refusedHandover.stdout)).toMatchObject({
      action: 'none',
      reason: 'handover-refused',
    });
    expect(stubCalls(handover, 'state').some((call) => call[1] === 'bump-attempt')).toBe(false);
  },
);
