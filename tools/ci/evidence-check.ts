// Required check `evidence-check` (规划/11 §3.2): an RV2 pull request carries a complete
// evidence file, the rule-test commit is an ancestor whose rule tests were not changed since,
// and the verified tree is the tree being merged.
//
//   node tools/ci/evidence-check.ts --pr <dir> --base <sha> --head <sha> --head-ref <branch>
//     [--pr-number <n>] [--ci-archive <dir>] [--json]
//
// Runs from the BASE copy of the repository (CI checks out `tools/ci` of the base branch, the
// way guard-git does), with the PR checkout as data: the risk map and the protected-path list
// come from this script's own checkout, never from the PR.
//
// What is checked, per risk level (computed by tools/guard/lib/risk.ts from the changed paths):
//   RV0 / RV1  pass; an evidence file for the task, when present, is validated all the same.
//   RV2        ops/evidence/<id>.json must exist at the head (id from the branch `task/<id>`):
//              task id, spec_ref = SPEC_REF of the head, spec_commit is an ancestor of the head
//              and no class 1 test asset changed between it and the head, one container run
//              with exit code 0 whose tree is the head tree, both reviewers pass with no open
//              S0 / S1, every recorded directory tree hash equals the head's, long-run result
//              bound to one of those trees.
//              Runs (CR-02): only a container run of the full `verify` script (`script:
//              "verify"`) counts as the verification; `verify:fast` (the implementer's own check)
//              and `host` are refused as evidence. A container red run (`script: "red"`,
//              tools/ops/verify-container.sh --red) must have passed red-check (exit 0), list its
//              red tests and have verified the spec_commit tree.
//              CI runs (`mode: ci`; 规划/11 §3.2, RO2-05, RO3-01, CR-03, CR-04): browser tests that
//              can only run in CI for now; never instead of the container run. Every field is
//              required: phase red|green, run_url, run_id, run_attempt 1, workflow, job, commit
//              (full SHA), tree (= that commit's tree), report_sha256, spec_commit (= the
//              evidence's). They are checked against the archived copy
//              rebate-private/ci-evidence/<run_id>/ (run.json with run_id, head_sha,
//              run_attempt, conclusion, workflow, job; a report file with that sha256); without
//              a readable archive the record is refused. green: commit is the head or an ancestor
//              and differs from it by this task's evidence file only (a new commit that only adds
//              the evidence is fine; any other change needs a new run), conclusion success,
//              skipped 0, exit code 0. red: the tested tree is the spec_commit tree, conclusion
//              failure with a non-zero exit code, and red_tests lists the red tests.
//              Owner waiver (owner decision 2026-10-02, ops/approvals.yaml id 12): on a branch
//              that is not task/<id> (test-change and gate-change PRs), the evidence file is
//              not required when the PR carries a valid owner approval label for the head (the
//              label check of the protected-paths workflow, tools/guard/lib/owner-approval.mjs;
//              looked up only with --pr-number) AND no changed path is a money / attribution
//              implementation path (MONEY_PATHS). Touching one keeps the requirement exactly as
//              before. Task branches are never waived.
// It prevents omissions, not malice (规划/11 §3.2). Exit codes: 0 ok, 1 failed, 2 usage.
//
// TODO(规划/11 §3.2): `run_attempt` > 1 on funds paths (不许重跑到绿) needs the Actions API and
//   a remote — blocked on GitHub remote.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, tryGit } from '../lib/git.ts';
import { matchesAny } from '../lib/glob.ts';
import { loadProtected, splitFragment } from '../guard/lib/protected.ts';
import type { ProtectedConfig } from '../guard/lib/protected.ts';
import { ownerApprovalFromEnv } from '../guard/lib/owner-approval-env.ts';
import type { OwnerApproval } from '../guard/lib/owner-approval-env.ts';
import { loadRiskMap, riskOfPaths } from '../guard/lib/risk.ts';
import { isAncestor } from '../guard/lib/spec-base.ts';
import type { RiskLevel } from '../guard/lib/risk.ts';

/**
 * Money and attribution implementation paths (owner decision 2026-10-02): a PR touching any of
 * them needs the evidence file even with an owner approval label. Matched case-insensitively.
 */
export const MONEY_PATHS: readonly string[] = [
  'packages/money/src/**',
  'packages/domain/src/**',
  'apps/api/src/modules/{ledger,commission,settlement,payout,withdrawals,reconciliation,orders,linking,union}/**',
  'db/migrations/**',
];

export type EvidenceReport = {
  ok: boolean;
  risk: RiskLevel;
  task: string | null;
  evidence_file: string | null;
  problems: string[];
  notices: string[];
  /** RV2 on a non-task branch touching no MONEY_PATHS: an owner approval would waive evidence. */
  waivable: boolean;
  /** The evidence requirement was waived by the owner approval. */
  waived: boolean;
  /** Changed paths that are money / attribution implementation paths. */
  money_paths: string[];
};

export type EvidenceInput = {
  /** PR checkout (full history). */
  prDir: string;
  base: string;
  head: string;
  headRef: string;
  /** The checkout whose risk map and protected-path list are used (this script's own). */
  trusted: string;
  /** Owner approval of the PR for `head`, when it was looked up (see ownerApprovalFromEnv). */
  approval?: OwnerApproval | null;
  /** rebate-private/ci-evidence; null or absent: CI records in the evidence are refused. */
  ciArchive?: string | null;
};

const SHA = /^[0-9a-f]{40,64}$/;
const SHORT_SHA = /^[0-9a-f]{7,64}$/;
const TASK_ID = /^[A-Z][A-Z0-9]*-[0-9]+[a-z]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Paths changed between two commits, both sides of a rename included. */
export function changedBetween(
  prDir: string,
  from: string,
  to: string,
): { path: string; status: string }[] {
  const out = git(
    [
      '-c',
      'core.quotepath=false',
      'diff',
      '--name-status',
      '-z',
      '-M',
      '--no-ext-diff',
      from,
      to,
      '--',
    ],
    { cwd: prDir },
  );
  const fields = out.split('\0');
  const changes: { path: string; status: string }[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++] ?? '';
    if (status === '') continue;
    const code = status[0] ?? '';
    if (code === 'R' || code === 'C') {
      const oldPath = fields[i++] ?? '';
      const path = fields[i++] ?? '';
      changes.push({ path, status: code === 'R' ? 'R' : 'A' });
      if (code === 'R') changes.push({ path: oldPath, status: 'D' });
    } else {
      changes.push({ path: fields[i++] ?? '', status: code });
    }
  }
  return changes;
}

function showOrNull(prDir: string, ref: string, path: string): string | null {
  const res = tryGit(['show', `${ref}:${path}`], { cwd: prDir });
  return res.status === 0 ? res.stdout : null;
}

function treeOf(prDir: string, ref: string, path?: string): string | null {
  const spec = path === undefined ? `${ref}^{tree}` : `${ref}:${path}`;
  const res = tryGit(['rev-parse', '--verify', '--quiet', spec], { cwd: prDir });
  const value = res.stdout.trim();
  return res.status === 0 && SHA.test(value) ? value : null;
}

/**
 * Tree of the head commit WITHOUT the evidence file itself: the verification ran before the
 * evidence was written (its `tree` is in the file), so the file cannot be part of the tree it
 * describes. A throwaway index in the git directory; the real index is not touched.
 */
export function headTreeWithoutEvidence(
  prDir: string,
  head: string,
  evidencePath: string,
): string | null {
  const gitDir = tryGit(['rev-parse', '--absolute-git-dir'], { cwd: prDir }).stdout.trim();
  if (gitDir === '') return null;
  const index = join(gitDir, `couli-evidence-index.${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' };
  const run = (args: string[]): string | null => {
    const res = spawnSync('git', args, { cwd: prDir, env, encoding: 'utf8' });
    return res.status === 0 ? res.stdout.trim() : null;
  };
  try {
    if (run(['read-tree', head]) === null) return null;
    run(['update-index', '--force-remove', '--', evidencePath]);
    const tree = run(['write-tree']);
    return tree !== null && SHA.test(tree) ? tree : null;
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}

function class1Hits(prDir: string, from: string, to: string, cfg: ProtectedConfig): string[] {
  const globs = cfg.class1_add_only.map((g) => splitFragment(g).glob);
  return changedBetween(prDir, from, to)
    .filter((c) => c.status !== 'A' && matchesAny(c.path, globs))
    .map((c) => `${c.path} (${c.status})`);
}

export type CiContext = {
  prDir: string;
  head: string;
  evidencePath: string;
  headTree: string | null;
  specCommit: unknown;
  /** rebate-private/ci-evidence (null: not available, every CI record is refused). */
  ciArchive: string | null;
};

const RUN_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/([0-9]+)(?:\/|$)/;

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** The archived copy of a CI run: run.json and the sha256 of every other file. */
function archivedRun(
  archive: string,
  runId: string,
): { meta: Record<string, unknown>; files: Set<string> } | string {
  const dir = join(archive, runId);
  const metaFile = join(dir, 'run.json');
  if (!existsSync(metaFile)) return `no archived run ${dir}/run.json (rebate-private/ci-evidence)`;
  let meta: unknown;
  try {
    meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  } catch {
    return `${metaFile} is not valid JSON`;
  }
  if (!isRecord(meta)) return `${metaFile} is not a JSON object`;
  const files = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (name === 'run.json') continue;
    const file = join(dir, name);
    if (statSync(file).isFile()) files.add(sha256File(file));
  }
  return { meta, files };
}

/**
 * A CI run (`mode: ci`; 规划/11 §3.2; RO2-05, RO3-01, CR-03, CR-04): every field present, bound to
 * the archived run and report, and to the right tree for its phase.
 */
export function ciRunProblems(run: Record<string, unknown>, ctx: CiContext): string[] {
  const problems: string[] = [];
  const phase = run['phase'];
  if (phase !== 'red' && phase !== 'green') problems.push('phase: must be red or green');
  const runId = typeof run['run_id'] === 'number' ? String(run['run_id']) : run['run_id'];
  if (typeof runId !== 'string' || !/^[1-9][0-9]*$/.test(runId)) {
    problems.push('run_id: must be the numeric GitHub Actions run id');
  }
  const url = typeof run['run_url'] === 'string' ? RUN_URL.exec(run['run_url']) : null;
  if (url === null)
    problems.push('run_url: must be the https://github.com/<o>/<r>/actions/runs/<id> link');
  else if (url[1] !== runId) problems.push('run_url: does not name run_id');
  for (const field of ['workflow', 'job']) {
    if (typeof run[field] !== 'string' || run[field] === '') problems.push(`${field}: required`);
  }
  if (run['run_attempt'] !== 1) problems.push('run_attempt: must be 1 (不许重跑到绿)');
  const commit = run['commit'];
  const tree = run['tree'];
  const report = run['report_sha256'];
  if (typeof commit !== 'string' || !SHA.test(commit)) {
    problems.push('commit: a CI run must name the full commit SHA it tested');
  }
  if (typeof tree !== 'string' || !SHA.test(tree)) problems.push('tree: must be a tree hash');
  if (typeof report !== 'string' || !/^[0-9a-f]{64}$/.test(report)) {
    problems.push('report_sha256: must be the sha256 of the archived report');
  }
  if (typeof run['spec_commit'] !== 'string' || run['spec_commit'] !== ctx.specCommit) {
    problems.push('spec_commit: a CI run must be bound to the evidence spec_commit');
  }
  if (problems.length > 0) return problems;

  // The tested commit and its tree.
  const sha = commit as string;
  const actualTree = treeOf(ctx.prDir, sha);
  if (actualTree === null) return [`commit: ${sha} is not a commit of this repository`];
  if (actualTree !== tree) problems.push(`tree: ${String(tree)} is not the tree of ${sha}`);

  // The archived run (rebate-private/ci-evidence/<run_id>/): the record may not claim more.
  if (ctx.ciArchive === null) {
    problems.push('the CI evidence archive (rebate-private/ci-evidence) is not available: refused');
  } else {
    const archived = archivedRun(ctx.ciArchive, runId as string);
    if (typeof archived === 'string') {
      problems.push(archived);
    } else {
      const m = archived.meta;
      const same = (key: string, value: unknown): void => {
        const got = key === 'run_id' && typeof m[key] === 'number' ? String(m[key]) : m[key];
        if (got !== value) {
          problems.push(
            `archive: run.json ${key} is ${JSON.stringify(m[key])}, the record says ${JSON.stringify(value)}`,
          );
        }
      };
      same('run_id', runId);
      same('head_sha', sha);
      same('run_attempt', run['run_attempt']);
      same('workflow', run['workflow']);
      same('job', run['job']);
      same('conclusion', run['conclusion']);
      if (!archived.files.has(report as string)) {
        problems.push('report_sha256: no archived report file has this sha256');
      }
    }
  }

  if (phase === 'green') {
    if (!isAncestor(ctx.prDir, sha, ctx.head)) {
      problems.push(`commit: ${sha} is not the head or an ancestor of it`);
    } else {
      const tested = headTreeWithoutEvidence(ctx.prDir, sha, ctx.evidencePath);
      if (tested === null || tested !== ctx.headTree) {
        problems.push(
          `commit: the tested tree ${tested ?? '(unknown)'} differs from the head tree ` +
            `${ctx.headTree ?? '(unknown)'} beyond ${ctx.evidencePath}: sources, tests or ` +
            'configuration changed after the CI run, run it again',
        );
      }
    }
    if (run['conclusion'] !== 'success') problems.push('conclusion: a green run must be success');
    if (run['skipped'] !== 0) problems.push('skipped: must be 0');
    if (run['exit_code'] !== 0) problems.push('exit_code: must be 0');
  } else {
    // A red run tested the rule tests before the implementation: the spec_commit tree.
    const specTree = typeof ctx.specCommit === 'string' ? treeOf(ctx.prDir, ctx.specCommit) : null;
    if (specTree === null || actualTree !== specTree) {
      problems.push(
        `tree: a red run must have tested the spec_commit tree ${specTree ?? '(unknown)'}, not ${actualTree}`,
      );
    }
    if (run['conclusion'] !== 'failure') problems.push('conclusion: a red run must be failure');
    if (typeof run['exit_code'] !== 'number' || run['exit_code'] === 0) {
      problems.push('exit_code: a red run fails (non-zero)');
    }
    const red = run['red_tests'];
    if (!Array.isArray(red) || red.length === 0 || !red.every((t) => typeof t === 'string')) {
      problems.push('red_tests: must list the tests that were red');
    }
  }
  return problems;
}

/** Validates one evidence document against the PR; returns the problems found. */
export function evidenceProblems(
  doc: unknown,
  ctx: {
    prDir: string;
    head: string;
    task: string;
    cfg: ProtectedConfig;
    /** rebate-private/ci-evidence; null or absent: CI records are refused. */
    ciArchive?: string | null;
  },
): string[] {
  const problems: string[] = [];
  if (!isRecord(doc)) return ['evidence is not a JSON object'];
  const at = (field: string, message: string): void => {
    problems.push(`${field}: ${message}`);
  };

  if (doc['task'] !== ctx.task)
    at('task', `must be "${ctx.task}" (got ${JSON.stringify(doc['task'])})`);

  const specRefHead = (showOrNull(ctx.prDir, ctx.head, 'SPEC_REF') ?? '').trim();
  if (typeof doc['spec_ref'] !== 'string' || !SHA.test(doc['spec_ref'])) {
    at('spec_ref', 'must be the 40-hex planning commit');
  } else if (doc['spec_ref'] !== specRefHead) {
    at('spec_ref', `differs from SPEC_REF of the head (${specRefHead || 'missing'})`);
  }

  const specCommit = doc['spec_commit'];
  if (typeof specCommit !== 'string' || !SHORT_SHA.test(specCommit)) {
    at('spec_commit', 'must be the rule-test commit id');
  } else {
    if (!isAncestor(ctx.prDir, specCommit, ctx.head)) {
      at('spec_commit', `${specCommit} is not an ancestor of the head ${ctx.head}`);
    } else {
      const changed = class1Hits(ctx.prDir, specCommit, ctx.head, ctx.cfg);
      if (changed.length > 0) {
        at('spec_commit', `rule tests changed after the rule-test commit: ${changed.join(', ')}`);
      }
    }
  }

  const evidencePath = `ops/evidence/${ctx.task}.json`;
  const headTree = headTreeWithoutEvidence(ctx.prDir, ctx.head, evidencePath);
  const runs = doc['runs'];
  if (!Array.isArray(runs) || runs.length === 0) {
    at('runs', 'must list at least one out-of-sandbox verification');
  } else {
    let verifiedHead = false;
    runs.forEach((run, i) => {
      if (!isRecord(run)) {
        at(`runs[${i}]`, 'must be an object');
        return;
      }
      const mode = run['mode'];
      const exit = run['exit_code'];
      const tree = run['tree'];
      if (mode === 'ci') {
        problems.push(
          ...ciRunProblems(run, {
            prDir: ctx.prDir,
            head: ctx.head,
            evidencePath,
            headTree,
            specCommit,
            ciArchive: ctx.ciArchive ?? null,
          }).map((p) => `runs[${i}]: ${p}`),
        );
        return;
      }
      if (mode === 'host') {
        at(`runs[${i}].mode`, 'host results are not accepted (规划/11 §2.3 第 7 步, §8)');
        return;
      }
      if (mode !== 'container') {
        at(`runs[${i}].mode`, 'must be container or ci');
        return;
      }
      if (typeof exit !== 'number') at(`runs[${i}].exit_code`, 'must be a number');
      if (typeof tree !== 'string' || !SHA.test(tree)) at(`runs[${i}].tree`, 'must be a tree hash');
      const script = run['script'];
      if (script === 'verify') {
        if (exit === 0 && tree === headTree) verifiedHead = true;
      } else if (script === 'red') {
        // The isolated red run (verify-container.sh --red): red-check passed on the spec_commit tree.
        const specTree =
          typeof specCommit === 'string' && SHORT_SHA.test(specCommit)
            ? treeOf(ctx.prDir, specCommit)
            : null;
        if (exit !== 0)
          at(`runs[${i}].exit_code`, 'a red run counts only when red-check passed (0)');
        if (specTree === null || tree !== specTree) {
          at(
            `runs[${i}].tree`,
            `a red run must have run on the spec_commit tree ${specTree ?? '(unknown)'}`,
          );
        }
        const red = run['red_tests'];
        if (!Array.isArray(red) || red.length === 0) {
          at(`runs[${i}].red_tests`, 'must list the tests that were red');
        }
      } else if (script === 'verify:fast') {
        at(
          `runs[${i}].script`,
          "verify:fast is the implementer's own check, not the verification (only `verify` counts)",
        );
      } else {
        at(
          `runs[${i}].script`,
          'must be verify or red (tools/ops/verify-container.sh result.json)',
        );
      }
    });
    if (!verifiedHead) {
      at(
        'runs',
        `no container run of \`verify\` with exit code 0 verified the head tree ${headTree ?? '(unknown)'} ` +
          '(the head tree without the evidence file itself; RV2 accepts container results ' +
          'only, 规划/11 §2.3 第 7 步)',
      );
    }
  }

  const reviews = doc['reviews'];
  if (!Array.isArray(reviews)) {
    at('reviews', 'must be a list');
  } else {
    for (const reviewer of ['claude', 'codex']) {
      const entry = reviews.find((r) => isRecord(r) && r['reviewer'] === reviewer);
      if (!isRecord(entry)) {
        at('reviews', `missing the ${reviewer} review (规划/11 §3.2 两家评审)`);
        continue;
      }
      if (entry['verdict'] !== 'pass') at(`reviews.${reviewer}.verdict`, 'must be pass');
      if (entry['open_s0_s1'] !== 0) at(`reviews.${reviewer}.open_s0_s1`, 'must be 0');
      if (reviewer === 'codex' && entry['checklist_complete'] !== true) {
        at('reviews.codex.checklist_complete', 'must be true (资金评审清单必填, 规划/11 §3.3)');
      }
    }
  }

  const trees = doc['trees'];
  const treeValues: string[] = [];
  if (!isRecord(trees) || Object.keys(trees).length === 0) {
    at('trees', 'must map each protected code directory to its tree hash');
  } else {
    for (const [path, value] of Object.entries(trees)) {
      const actual = treeOf(ctx.prDir, ctx.head, path);
      if (typeof value !== 'string' || !SHA.test(value)) {
        at(`trees["${path}"]`, 'must be a tree hash');
      } else if (actual === null) {
        at(`trees["${path}"]`, 'path does not exist at the head');
      } else if (actual !== value) {
        at(`trees["${path}"]`, `recorded ${value}, head has ${actual}`);
      } else {
        treeValues.push(value);
      }
    }
  }

  const longrun = doc['longrun'];
  if (!isRecord(longrun)) {
    at('longrun', 'must be an object (长跑属性测试, 规划/11 §3.2)');
  } else {
    if (longrun['passed'] !== true) at('longrun.passed', 'must be true');
    if (typeof longrun['tree'] !== 'string' || !treeValues.includes(longrun['tree'])) {
      at('longrun.tree', 'must equal one of the tree hashes recorded in `trees`');
    }
  }
  return problems;
}

export function checkEvidence(input: EvidenceInput): EvidenceReport {
  const problems: string[] = [];
  const notices: string[] = [];
  const cfg = loadProtected(input.trusted);
  const riskMap = loadRiskMap(input.trusted);
  for (const [name, ref] of [
    ['base', input.base],
    ['head', input.head],
  ] as const) {
    if (!SHORT_SHA.test(ref)) throw new Error(`--${name} must be a commit id`);
    if (
      tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: input.prDir })
        .status !== 0
    ) {
      throw new Error(`--${name} ${ref} is not a commit in ${input.prDir}`);
    }
  }
  const mergeBase = git(['merge-base', input.base, input.head], { cwd: input.prDir });
  const changed = changedBetween(input.prDir, mergeBase, input.head).map((c) => c.path);
  const risk = riskOfPaths(changed, riskMap, cfg).risk;
  const branch = /^task\/(.+)$/.exec(input.headRef);
  const task = branch !== null && TASK_ID.test(branch[1] ?? '') ? (branch[1] ?? null) : null;
  const evidencePath = task === null ? null : `ops/evidence/${task}.json`;
  const text = evidencePath === null ? null : showOrNull(input.prDir, input.head, evidencePath);
  const moneyPaths = changed.filter((p) => matchesAny(p.toLowerCase(), MONEY_PATHS));
  const waivable = risk === 'RV2' && task === null && moneyPaths.length === 0;
  const approval = input.approval ?? null;
  let waived = false;

  if (risk !== 'RV2') {
    notices.push(`risk ${risk}: no evidence file required (${changed.length} changed path(s))`);
  } else if (task === null && waivable && approval?.approved === true) {
    waived = true;
    notices.push(
      `RV2 change on branch "${input.headRef}": evidence file waived by the owner approval ` +
        `(${approval.reason}); no money / attribution implementation path changed`,
    );
  } else if (task === null) {
    problems.push(
      `RV2 change on branch "${input.headRef}": the branch must be task/<id> so that ` +
        'ops/evidence/<id>.json can be checked',
    );
    if (moneyPaths.length > 0) {
      problems.push(
        `money / attribution implementation paths changed (${moneyPaths.join(', ')}): an owner ` +
          'approval label does not waive the evidence file',
      );
    } else if (approval !== null) {
      problems.push(`owner approval: no (${approval.reason})`);
    } else {
      notices.push(
        'an owner approval label for the head would waive the evidence file (no money / ' +
          'attribution implementation path changed); it is looked up only with --pr-number',
      );
    }
  } else if (text === null) {
    problems.push(`RV2 change without ${evidencePath} at the head (规划/11 §3.2 证据文件)`);
  }

  if (text !== null && task !== null) {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      doc = undefined;
      problems.push(
        `${evidencePath}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (doc !== undefined) {
      problems.push(
        ...evidenceProblems(doc, {
          prDir: input.prDir,
          head: input.head,
          task,
          cfg,
          ciArchive: input.ciArchive ?? null,
        }).map((p) => `${evidencePath}: ${p}`),
      );
    }
  }
  return {
    ok: problems.length === 0,
    risk,
    task,
    evidence_file: evidencePath,
    problems,
    notices,
    waivable,
    waived,
    money_paths: moneyPaths,
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--json') {
      json = true;
      continue;
    }
    const value = argv[i + 1];
    if (
      !['--pr', '--base', '--head', '--head-ref', '--pr-number', '--ci-archive'].includes(arg) ||
      value === undefined
    ) {
      throw new Error(
        'usage: evidence-check.ts --pr <dir> --base <sha> --head <sha> --head-ref <branch> ' +
          '[--pr-number <n>] [--ci-archive <rebate-private/ci-evidence>] [--json]',
      );
    }
    values.set(arg, value);
    i++;
  }
  const prDir = values.get('--pr');
  const base = values.get('--base');
  const head = values.get('--head');
  const headRef = values.get('--head-ref');
  if (prDir === undefined || base === undefined || head === undefined || headRef === undefined) {
    throw new Error('--pr, --base, --head and --head-ref are required');
  }
  const prNumber = values.get('--pr-number');
  if (prNumber !== undefined && !/^[1-9][0-9]*$/.test(prNumber)) {
    throw new Error('--pr-number must be a pull request number');
  }
  const input: EvidenceInput = {
    prDir: resolve(prDir),
    base,
    head,
    headRef,
    trusted: resolve(import.meta.dirname, '../..'),
    // rebate-private/ci-evidence (规划/11 §3.2, §4.5): --ci-archive, COULI_CI_EVIDENCE, else the
    // sibling checkout; missing means CI records are refused.
    ciArchive: ((): string | null => {
      const dir =
        values.get('--ci-archive') ??
        process.env['COULI_CI_EVIDENCE'] ??
        resolve(import.meta.dirname, '../../../rebate-private/ci-evidence');
      return existsSync(dir) ? resolve(dir) : null;
    })(),
  };
  let report = checkEvidence(input);
  // The API is asked only when an approval could change the outcome.
  if (!report.ok && report.waivable && prNumber !== undefined) {
    const fullHead = git(['rev-parse', '--verify', `${head}^{commit}`], { cwd: input.prDir });
    const approval = await ownerApprovalFromEnv(prNumber, fullHead);
    report = checkEvidence({ ...input, approval });
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  for (const notice of report.notices) console.error(`evidence-check: notice: ${notice}`);
  for (const problem of report.problems) console.error(`evidence-check: ${problem}`);
  console.error(
    report.ok ? 'evidence-check: ok' : `evidence-check: ${report.problems.length} problem(s)`,
  );
  return report.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`evidence-check: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}
