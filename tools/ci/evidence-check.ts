// Required check `evidence-check` (规划/11 §3.2): an RV2 pull request carries a complete
// evidence file, the rule-test commit is an ancestor whose rule tests were not changed since,
// and the verified tree is the tree being merged.
//
//   node tools/ci/evidence-check.ts --pr <dir> --base <sha> --head <sha> --head-ref <branch>
//     [--pr-number <n>] [--json]
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
//              Red run (CR2-05): a task whose rule tests Codex writes (ledger tester: codex)
//              and that is not a ledger of the switch baseline (tools/guard/legacy-tasks.json)
//              needs a valid container red run: script red, exit 0 (red-check passed), on the
//              spec_commit tree, its `expected` list covering every rule-test file the task
//              added inside its test_paths (base..spec_commit), each with a red test.
//              CI runs (`mode: ci`) are refused for now (CR2-06): the CI evidence archive
//              (rebate-private/ci-evidence) is not connected, so nothing a CI record says can be
//              checked against the run and its report.
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
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, tryGit } from '../lib/git.ts';
import type { Change } from '../lib/git.ts';
import { loadLegacyTasks } from '../lib/legacy-tasks.ts';
import { parseTaskFile } from '../lib/task-file.ts';
import type { TaskFile } from '../lib/task-file.ts';
import { expectedRuleTests } from '../guard/lib/red-check.ts';
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

// TODO(规划/11 §3.2, §4.5): accept `mode: ci` records (browser tests) once the CI evidence archive
// rebate-private/ci-evidence/<run_id>/ is connected: bind run_url, run_id, run_attempt, workflow,
// job, commit, tree and report_sha256 to the archived run and report, parse the report (tests
// that ran, failure causes, skipped count) and an allow-list of browser jobs — blocked on the
// archive (records-from-junit.ts) and the browser workflow (Codex review CR2-06).
export const CI_REFUSED =
  'CI 证据归档未接入，暂不接受 mode: ci 记录（规划/11 §3.2；Codex 评审 CR2-06）';

/** What the red-run requirement of a task needs (CR2-05). */
export type RedRequirement = {
  required: boolean;
  /** Rule-test files the task added inside its test_paths, base..spec_commit. */
  expected: string[];
};

/** Validates one evidence document against the PR; returns the problems found. */
export function evidenceProblems(
  doc: unknown,
  ctx: {
    prDir: string;
    head: string;
    task: string;
    cfg: ProtectedConfig;
    /** The red-run requirement (absent: required, no expected files: fail-closed). */
    red?: RedRequirement;
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
    let verifiedRed = false;
    const red = ctx.red ?? { required: true, expected: [] };
    runs.forEach((run, i) => {
      if (!isRecord(run)) {
        at(`runs[${i}]`, 'must be an object');
        return;
      }
      const mode = run['mode'];
      const exit = run['exit_code'];
      const tree = run['tree'];
      if (mode === 'ci') {
        at(`runs[${i}].mode`, CI_REFUSED);
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
        const redTests = run['red_tests'];
        const listed = run['expected'];
        const before = problems.length;
        if (!Array.isArray(redTests) || redTests.length === 0) {
          at(`runs[${i}].red_tests`, 'must list the tests that were red');
        }
        // Coverage (CR2-05): every rule-test file the task added ran and has a red test.
        for (const file of red.expected) {
          if (!Array.isArray(listed) || !listed.includes(file)) {
            at(`runs[${i}].expected`, `does not cover ${file}, a rule-test file the task added`);
          } else if (
            !Array.isArray(redTests) ||
            !redTests.some((t) => typeof t === 'string' && t.startsWith(`${file} > `))
          ) {
            at(`runs[${i}].red_tests`, `no red test of ${file}`);
          }
        }
        if (problems.length === before && exit === 0 && specTree !== null && tree === specTree) {
          verifiedRed = true;
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
    if (red.required && red.expected.length === 0) {
      at(
        'runs',
        'the task added no rule-test file inside its test_paths before spec_commit: nothing was shown red',
      );
    } else if (red.required && !verifiedRed) {
      at(
        'runs',
        'no valid red run (container, script red, red-check passed on the spec_commit tree, ' +
          'covering every rule-test file the task added): the rule tests were never shown red ' +
          '(规划/11 §2.3 第 3 步; tools/ops/verify-container.sh --red)',
      );
    }
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

/**
 * Whether the task needs a red run, and which rule-test files it must cover (CR2-05). The ledger
 * comes from the trusted root, or from the head when the PR adds it; the switch-baseline list
 * from the trusted root. A ledger that cannot be read requires the red run with no expected
 * file, which fails (fail-closed).
 */
export function redRequirement(
  input: EvidenceInput,
  task: string,
  mergeBase: string,
  evidenceText: string,
): RedRequirement {
  const rel = `ops/tasks/${task}.yaml`;
  const trustedFile = join(input.trusted, rel);
  let ledger: TaskFile | null = null;
  try {
    ledger = existsSync(trustedFile)
      ? parseTaskFile(readFileSync(trustedFile, 'utf8'), rel)
      : parseTaskFile(showOrNull(input.prDir, input.head, rel) ?? '', rel);
  } catch {
    ledger = null;
  }
  if (ledger === null) return { required: true, expected: [] };
  const legacy = loadLegacyTasks(input.trusted);
  if (ledger.tester !== 'codex' || legacy.has(ledger.id)) return { required: false, expected: [] };
  let specCommit: unknown;
  try {
    specCommit = (JSON.parse(evidenceText) as Record<string, unknown>)['spec_commit'];
  } catch {
    specCommit = null;
  }
  if (typeof specCommit !== 'string' || !SHORT_SHA.test(specCommit)) {
    return { required: true, expected: [] };
  }
  const changes = changedBetween(input.prDir, mergeBase, specCommit).map((c) => ({
    path: c.path,
    status: c.status as Change['status'],
  }));
  return { required: true, expected: expectedRuleTests(changes, ledger.test_paths) };
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
    const red = redRequirement(input, task, mergeBase, text);
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
          red,
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
      !['--pr', '--base', '--head', '--head-ref', '--pr-number'].includes(arg) ||
      value === undefined
    ) {
      throw new Error(
        'usage: evidence-check.ts --pr <dir> --base <sha> --head <sha> --head-ref <branch> ' +
          '[--pr-number <n>] [--json]',
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
