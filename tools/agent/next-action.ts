// Decides the orchestrator's next step after a Codex run in impl mode (规划/11 §2.3 steps 3 and 6,
// §2.5). Used by post-run.sh; it reads files only and never touches git or the worktree.
//
// Phases (default split of 2026-10-05, ops/approvals.yaml id 19; meta.json `phase`):
//   test      Codex wrote rule tests and NotImplemented skeletons. Success is `red-check`: the
//             orchestrator checks they are red for the right reason (tools/guard/red-check.ts),
//             commits them as test(spec), records spec_commit, and for RV2 has a FRESH CLAUDE
//             SUBAGENT do the spec-test review (never Codex: README §11). No verification run.
//   handover  Codex implemented once after the Opus attempts ran out (RV0 / RV1): as `impl`, with
//             the handover counter (one attempt).
//   impl      (default; a meta.json without phase) a Codex implementation as before 2026-10-05.
// The Opus implementation subagent does not go through here (README §10).
//
//   node next-action.ts --task <id> --run <dir> --meta <meta.json> --attempts <n>
//                       [--phase test|handover|impl] [--base <ref>] [--impl <impl.json>]
//                       [--path-guard <json> --path-guard-exit <n>]
//                       [--protected <json> --protected-exit <n>]
//   node next-action.ts --task <id> --run <dir> --attempts <n> --failure <reason> [--detail <text>]
//       A failed attempt that left no finished meta.json (orphaned run).
//
// Prints one JSON line
// `{ "action": "verify" | "red-check" | "retry" | "blocked" | "ask" | "capacity-retry", … }`.
// Exit codes: 0 decided, 2 usage or internal error.
import { existsSync } from 'node:fs';
import { readJsonFile } from '../lib/fsx.ts';
import { ATTEMPT_LIMITS, uncountedReason } from '../ops/state.ts';

/** 规划/11 §2.5: at most 3 implementation attempts; re-dispatch after 15, 30, 60 minutes. */
export const MAX_IMPL_ATTEMPTS = 3;

export const RUN_PHASES = ['test', 'handover', 'impl'] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

/** Attempts of a phase: test 3, handover 1, impl 3 (tools/ops/state.ts ATTEMPT_LIMITS). */
export function phaseLimit(phase: RunPhase): number {
  return ATTEMPT_LIMITS[phase];
}
export const BACKOFF_MINUTES = [15, 30, 60] as const;

export type ProtectedHit = { path: string; class: number };

export type GuardRun = { exit: number; report: Record<string, unknown> | null };

export type Input = {
  task: string;
  run: string;
  /** Default `impl`. */
  phase?: RunPhase;
  /** RUN/meta.impl.json as written by codex-run.sh. */
  meta: Record<string, unknown>;
  /**
   * state.attempts.impl after codex-run.sh settled the run: it is counted, unless it ended
   * without output and was given back (规划/11 §2.5, tools/ops/state.ts settle).
   */
  attempts: number;
  base: string | null;
  /** RUN/impl.json; only present when the wrapper accepted it. */
  impl: Record<string, unknown> | null;
  pathGuard: GuardRun | null;
  protectedPaths: GuardRun | null;
};

export type Action = {
  action: 'verify' | 'red-check' | 'retry' | 'blocked' | 'ask' | 'capacity-retry';
} & Record<string, unknown>;

export function backoffMinutes(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1;
  return BACKOFF_MINUTES[index] ?? 60;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hitsOf(value: unknown): ProtectedHit[] {
  const hits: ProtectedHit[] = [];
  for (const entry of asArray(value)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { path, class: cls } = entry as { path?: unknown; class?: unknown };
    if (typeof path === 'string' && typeof cls === 'number') hits.push({ path, class: cls });
  }
  return hits;
}

/** A failed attempt: retry with backoff, or stop when the attempts are used up. */
export function failed(
  input: Pick<Input, 'task' | 'run' | 'attempts' | 'phase'>,
  reason: string,
  extra: Record<string, unknown> = {},
): Action {
  const common = { task: input.task, run: input.run, reason, attempt: input.attempts, ...extra };
  if (input.attempts >= phaseLimit(input.phase ?? 'impl')) {
    // RV0 / RV1 may be handed to the other implementer once, RV2 stays blocked (规划/11 §2.5);
    // that choice needs the risk level and is the orchestrator's.
    return { action: 'blocked', ...common, reason: 'attempts-exhausted', last_failure: reason };
  }
  return { action: 'retry', ...common, backoff_min: backoffMinutes(input.attempts) };
}

export function nextAction(input: Input): Action {
  const { meta } = input;
  const common = { task: input.task, run: input.run };
  const exitCode = typeof meta['exit_code'] === 'number' ? meta['exit_code'] : null;
  if (exitCode === null) throw new Error('meta.json has no exit_code: the run is not finished');

  // Does this call use up a round? Only a call that ended without output is given back
  // (codex-run.sh runs state.ts settle); every finished call still counts towards the per-task
  // call cap and the no-output breaker (规划/11 §2.5, tools/ops/state.ts taskCalls).
  const countsAsAttempt =
    uncountedReason({
      mode: 'impl',
      review_type: null,
      phase: null,
      started_at: '',
      exit_code: exitCode,
      has_output: meta['has_output'] === true,
      idle_killed: meta['idle_killed'] === true,
      validation: typeof meta['validation'] === 'string' ? meta['validation'] : null,
    }) === null;

  if (exitCode === 11) {
    // Model capacity: retried with backoff and NOT counted in attempts (codex-run.sh gives the
    // round back); it still counts towards the per-task call cap.
    return {
      action: 'capacity-retry',
      ...common,
      attempt: input.attempts,
      backoff_min: backoffMinutes(input.attempts),
      counts_as_attempt: false,
    };
  }
  if (exitCode === 12) {
    // HEAD, branches or index changed during the run: nothing of this worktree may be executed
    // or committed until the orchestrator has inspected and reset it.
    return {
      action: 'blocked',
      ...common,
      reason: 'position-assertion',
      attempt: input.attempts,
      position_changed: asArray(meta['position_changed']),
    };
  }
  if (exitCode === 124) {
    return failed(input, meta['idle_killed'] === true ? 'inactivity-kill' : 'timeout', {
      counts_as_attempt: countsAsAttempt,
    });
  }
  if (exitCode !== 0) {
    return failed(input, 'no-usable-output', {
      codex_exit: meta['codex_exit'] ?? null,
      validation: meta['validation'] ?? null,
      counts_as_attempt: countsAsAttempt,
    });
  }

  // Usable output. Guards first: nothing from the worktree runs before they pass (§2.3 step 6).
  const { pathGuard, protectedPaths } = input;
  if (pathGuard === null || protectedPaths === null || input.base === null) {
    return { action: 'blocked', ...common, reason: 'guards-not-run', attempt: input.attempts };
  }
  for (const [name, guard] of [
    ['path-guard', pathGuard],
    ['protected-paths', protectedPaths],
  ] as const) {
    if ((guard.exit !== 0 && guard.exit !== 1) || guard.report === null) {
      return {
        action: 'blocked',
        ...common,
        reason: 'guard-error',
        guard: name,
        guard_exit: guard.exit,
        attempt: input.attempts,
      };
    }
  }
  const pathReport = pathGuard.report ?? {};
  const protectedReport = protectedPaths.report ?? {};
  const hits = [...hitsOf(protectedReport['hits']), ...hitsOf(pathReport['protected_hits'])];
  const seen = new Set<string>();
  const uniqueHits = hits.filter((hit) => {
    const id = `${hit.class}:${hit.path}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const gateHits = uniqueHits.filter((hit) => hit.class === 2 || hit.class === 3);
  const violations = asArray(pathReport['violations']);
  const class1 = uniqueHits.filter((hit) => hit.class === 1);
  const outOfScope = asArray(pathReport['out_of_scope_ops_docs']);
  // Out-of-bounds first (规划/11 §2.3 step 6: 越界的改动一律不运行): a diff that leaves the task
  // paths, or touches class 1 test assets, is a failed attempt even when it also hits a gate
  // path. Only a diff that lies entirely inside the task paths can be put to the owner.
  if (violations.length > 0 || class1.length > 0) {
    return failed(input, 'out-of-bounds', {
      base: input.base,
      violations,
      protected_class1: class1,
      protected_gate_hits: gateHits,
    });
  }
  if (gateHits.length > 0) {
    // 规划/11 §3.2: class 2 / 3 always go to the owner, whether they tighten or loosen. The
    // full picture travels with the question: nothing else in the diff is hidden behind it.
    return {
      action: 'ask',
      ...common,
      reason: 'protected-path',
      base: input.base,
      attempt: input.attempts,
      hits: gateHits,
      violations,
      protected_class1: class1,
      out_of_scope_ops_docs: outOfScope,
    };
  }
  if (pathGuard.exit !== 0 || protectedPaths.exit !== 0) {
    // A guard failed without naming a hit the lists above would show: never run the code.
    return failed(input, 'out-of-bounds', {
      base: input.base,
      violations,
      protected_class1: class1,
      protected_gate_hits: gateHits,
    });
  }

  const impl = input.impl;
  if (impl === null) {
    return { action: 'blocked', ...common, reason: 'output-missing', attempt: input.attempts };
  }
  // Everything below is the implementer's own account: data for the orchestrator, not a verdict.
  const depsNeeded = asArray(impl['deps_needed']);
  const outsideNeeded = asArray(impl['outside_needed']);
  const blockedReason = typeof impl['blocked_reason'] === 'string' ? impl['blocked_reason'] : '';
  if (depsNeeded.length > 0) {
    // 规划/11 §2.3: the orchestrator opens a `deps` task, then re-dispatches.
    return {
      action: 'blocked',
      ...common,
      reason: 'deps-needed',
      attempt: input.attempts,
      deps_needed: depsNeeded,
    };
  }
  if (blockedReason.trim() !== '') {
    return {
      action: 'blocked',
      ...common,
      reason: 'implementer-blocked',
      attempt: input.attempts,
      blocked_reason: blockedReason,
      outside_needed: outsideNeeded,
    };
  }
  if (impl['task_done'] !== true) return failed(input, 'not-done');

  if ((input.phase ?? 'impl') === 'test') {
    // Rule tests written by Codex: nothing is verified yet (they are meant to be red). The
    // orchestrator checks the red, commits, and has the tests reviewed by a fresh Claude
    // subagent (RV2), never by Codex (规划/11 §2.3 steps 3-4; ops/approvals.yaml id 19).
    return {
      action: 'red-check',
      ...common,
      phase: 'test',
      attempt: input.attempts,
      base: input.base,
      worktree: meta['worktree'] ?? null,
      // The isolated red run: only the task's new rule tests, in the container, reports exported
      // and reconciled by red-check (CR-12); its result.json goes into the evidence.
      red_check: `tools/ops/verify-container.sh ${input.task} --red`,
      then: [
        'commit the rule tests and skeletons as test(spec): …; state.ts set --spec-commit <sha>',
        'RV2: spec-test review by a fresh Claude subagent (tools/agent/README.md §11)',
        'implementation by a Claude Opus subagent (tools/agent/README.md §10)',
      ],
      revert_first: asArray(pathReport['out_of_scope_ops_docs']),
      outside_needed: outsideNeeded,
    };
  }

  return {
    action: 'verify',
    ...common,
    attempt: input.attempts,
    base: input.base,
    worktree: meta['worktree'] ?? null,
    // The task passes or fails on this command only (规划/11 §2.3 step 7).
    verify: `tools/ops/verify-container.sh ${input.task}`,
    // ops/ and docs/ changes outside the task paths are reverted by the orchestrator first and
    // do not count as a failure (§2.3 step 6).
    revert_first: asArray(pathReport['out_of_scope_ops_docs']),
    outside_needed: outsideNeeded,
  };
}

class UsageError extends Error {}

function readObject(file: string): Record<string, unknown> {
  const doc = readJsonFile(file);
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error(`${file}: not a JSON object`);
  }
  return doc as Record<string, unknown>;
}

function readGuard(file: string | undefined, exit: string | undefined): GuardRun | null {
  if (file === undefined || exit === undefined) return null;
  if (!/^\d+$/.test(exit)) throw new UsageError(`guard exit code is not a number: ${exit}`);
  let report: Record<string, unknown> | null = null;
  try {
    report = readObject(file);
  } catch {
    report = null;
  }
  return { exit: Number(exit), report };
}

function main(argv: readonly string[]): number {
  const values = new Map<string, string>();
  const known = [
    '--task',
    '--run',
    '--meta',
    '--attempts',
    '--phase',
    '--base',
    '--impl',
    '--path-guard',
    '--path-guard-exit',
    '--protected',
    '--protected-exit',
    '--failure',
    '--detail',
  ];
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? '';
    const value = argv[i + 1];
    if (!known.includes(flag) || value === undefined) throw new UsageError(`bad argument: ${flag}`);
    values.set(flag, value);
  }
  const task = values.get('--task');
  const run = values.get('--run');
  const metaFile = values.get('--meta');
  const attempts = values.get('--attempts');
  if (task === undefined || run === undefined || attempts === undefined) {
    throw new UsageError('--task, --run and --attempts are required');
  }
  if (!/^\d+$/.test(attempts)) throw new UsageError('--attempts must be a non-negative integer');
  const phaseArg = values.get('--phase') ?? 'impl';
  if (!(RUN_PHASES as readonly string[]).includes(phaseArg)) {
    throw new UsageError(`--phase must be one of ${RUN_PHASES.join(', ')}`);
  }
  const phase = phaseArg as RunPhase;
  const failure = values.get('--failure');
  if (failure !== undefined) {
    const detail = values.get('--detail') ?? '';
    const orphan = failed({ task, run, attempts: Number(attempts), phase }, failure, { detail });
    process.stdout.write(`${JSON.stringify(orphan)}\n`);
    return 0;
  }
  if (metaFile === undefined) throw new UsageError('--meta is required');
  const implFile = values.get('--impl');
  const action = nextAction({
    task,
    run,
    phase,
    meta: readObject(metaFile),
    attempts: Number(attempts),
    base: values.get('--base') ?? null,
    impl: implFile !== undefined && existsSync(implFile) ? readObject(implFile) : null,
    pathGuard: readGuard(values.get('--path-guard'), values.get('--path-guard-exit')),
    protectedPaths: readGuard(values.get('--protected'), values.get('--protected-exit')),
  });
  process.stdout.write(`${JSON.stringify(action)}\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `next-action.ts: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
