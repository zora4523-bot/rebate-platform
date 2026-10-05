// evidence-check.ts against a fixture repository: an RV2 branch with and without a complete
// evidence file, an RV0 branch, and each field that must make the check fail.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { checkEvidence, evidenceProblems, headTreeWithoutEvidence } from './evidence-check.ts';
import { loadProtected } from '../guard/lib/protected.ts';

const REPO = resolve(import.meta.dirname, '../..');
const SCRATCH = join(REPO, '.tmp', `ci-evidence-${process.pid}`);
const SPEC_REF = 'c'.repeat(40);

function git(cwd: string, args: string[]): string {
  const res = spawnSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

let repo = '';
let base = '';
let specCommit = '';
let headTree = '';
let moneyTree = '';

type Evidence = Record<string, unknown>;

/** A complete, correct evidence document for the head commit of `branch`. */
function evidence(extra: Evidence = {}): Evidence {
  return {
    task: 'B2-01a',
    spec_ref: SPEC_REF,
    spec_commit: specCommit,
    red_tests: ['money: rounds down'],
    runs: [{ mode: 'container', exit_code: 0, commit: null, tree: headTree, prop_seed: 1 }],
    reviews: [
      { reviewer: 'claude', verdict: 'pass', open_s0_s1: 0 },
      { reviewer: 'codex', verdict: 'pass', open_s0_s1: 0, checklist_complete: true },
    ],
    trees: { 'packages/money': moneyTree },
    longrun: { runs: 1000000, seed: 1, passed: true, tree: moneyTree },
    ...extra,
  };
}

/** Adds a commit on top of HEAD with the evidence file and returns its sha. */
function commitEvidence(doc: Evidence | string): string {
  write(repo, {
    'ops/evidence/B2-01a.json': typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`,
  });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'evidence']);
  return git(repo, ['rev-parse', 'HEAD']);
}

beforeAll(() => {
  repo = join(SCRATCH, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  write(repo, {
    SPEC_REF: `${SPEC_REF}\n`,
    'packages/money/src/index.ts': 'export const a = 1;\n',
    'docs/README.md': '# docs\n',
    'test/spec/money/round.test.ts': 'it("rounds", () => {});\n',
  });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  base = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-q', '-b', 'task/B2-01a']);
  // The rule-test commit, then the implementation.
  write(repo, { 'test/spec/money/floor.test.ts': 'it("floors", () => {});\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'test(spec): floor']);
  specCommit = git(repo, ['rev-parse', 'HEAD']);
  write(repo, { 'packages/money/src/index.ts': 'export const a = 2;\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'impl']);
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function check(head: string, headRef = 'task/B2-01a') {
  return checkEvidence({ prDir: repo, base, head, headRef, trusted: REPO });
}

it('an RV2 branch without an evidence file fails; with a complete one it passes', () => {
  const impl = git(repo, ['rev-parse', 'HEAD']);
  const missing = check(impl);
  expect(missing.ok).toBe(false);
  expect(missing.risk).toBe('RV2');
  expect(missing.problems.join('\n')).toContain('without ops/evidence/B2-01a.json');

  // The verification ran on the implementation tree; the evidence file is committed on top
  // and is excluded when the head tree is compared (it cannot describe itself).
  headTree = git(repo, ['rev-parse', `${impl}^{tree}`]);
  moneyTree = git(repo, ['rev-parse', `${impl}:packages/money`]);
  const head = commitEvidence(evidence());
  expect(headTreeWithoutEvidence(repo, head, 'ops/evidence/B2-01a.json')).toBe(headTree);
  expect(git(repo, ['rev-parse', `${head}^{tree}`])).not.toBe(headTree);

  const good = check(head);
  expect(good.problems).toEqual([]);
  expect(good).toMatchObject({ ok: true, risk: 'RV2', task: 'B2-01a' });

  // A branch name that is not task/<id> cannot be checked.
  const noTask = check(head, 'feature/x');
  expect(noTask.ok).toBe(false);
  expect(noTask.problems.join('\n')).toContain('task/<id>');
});

it('every field of the evidence can fail the check', () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const problemsOf = (doc: unknown): string =>
    evidenceProblems(doc, { prDir: repo, head, task: 'B2-01a', cfg }).join('\n');
  const otherTree = git(repo, ['rev-parse', `${base}^{tree}`]);
  const cases: [string, Evidence | string, RegExp][] = [
    ['task', evidence({ task: 'B2-02' }), /task: must be "B2-01a"/],
    ['spec_ref', evidence({ spec_ref: 'd'.repeat(40) }), /spec_ref: differs from SPEC_REF/],
    ['spec_commit not an ancestor', evidence({ spec_commit: 'e'.repeat(40) }), /not an ancestor/],
    [
      'no container run',
      evidence({ runs: [{ mode: 'host', exit_code: 0, tree: headTree }] }),
      /no container run/,
    ],
    [
      'failed run',
      evidence({ runs: [{ mode: 'container', exit_code: 1, tree: headTree }] }),
      /no container run/,
    ],
    [
      'other tree',
      evidence({ runs: [{ mode: 'container', exit_code: 0, tree: otherTree }] }),
      /no container run/,
    ],
    [
      'missing codex review',
      evidence({ reviews: [{ reviewer: 'claude', verdict: 'pass', open_s0_s1: 0 }] }),
      /missing the codex review/,
    ],
    [
      'open S0',
      evidence({
        reviews: [
          { reviewer: 'claude', verdict: 'pass', open_s0_s1: 1 },
          { reviewer: 'codex', verdict: 'pass', open_s0_s1: 0, checklist_complete: true },
        ],
      }),
      /reviews.claude.open_s0_s1: must be 0/,
    ],
    [
      'checklist',
      evidence({
        reviews: [
          { reviewer: 'claude', verdict: 'pass', open_s0_s1: 0 },
          { reviewer: 'codex', verdict: 'pass', open_s0_s1: 0, checklist_complete: false },
        ],
      }),
      /checklist_complete: must be true/,
    ],
    ['tree mismatch', evidence({ trees: { 'packages/money': otherTree } }), /recorded .* head has/],
    [
      'tree path missing',
      evidence({ trees: { 'packages/nope': moneyTree } }),
      /does not exist at the head/,
    ],
    [
      'longrun failed',
      evidence({ longrun: { passed: false, tree: moneyTree } }),
      /longrun.passed: must be true/,
    ],
    [
      'longrun tree',
      evidence({ longrun: { passed: true, tree: otherTree } }),
      /longrun.tree: must equal/,
    ],
    ['not an object', '[]', /not a JSON object/],
  ];
  for (const [name, doc, pattern] of cases) {
    const parsed = typeof doc === 'string' ? JSON.parse(doc) : doc;
    expect(problemsOf(parsed), name).toMatch(pattern);
  }
  expect(problemsOf(evidence())).toBe('');
});

it('rule tests changed after the rule-test commit fail the check', () => {
  git(repo, ['checkout', '-q', '-b', 'task/B2-01b', 'task/B2-01a']);
  write(repo, { 'test/spec/money/floor.test.ts': 'it("floors differently", () => {});\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'weaken the rule test']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const problems = evidenceProblems(evidence(), { prDir: repo, head, task: 'B2-01a', cfg });
  expect(problems.join('\n')).toContain('rule tests changed after the rule-test commit');
  expect(problems.join('\n')).toContain('test/spec/money/floor.test.ts (M)');
  git(repo, ['checkout', '-q', 'task/B2-01a']);
});

it('an RV0 branch needs no evidence file', () => {
  git(repo, ['checkout', '-q', '-b', 'task/D0-01', base]);
  write(repo, { 'docs/README.md': '# docs, updated\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'docs']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const report = check(head, 'task/D0-01');
  expect(report).toMatchObject({ ok: true, risk: 'RV0', task: 'D0-01', problems: [] });
  expect(report.notices.join('\n')).toContain('no evidence file required');
  git(repo, ['checkout', '-q', 'task/B2-01a']);
});

it('the CLI exits 1 on a failure and 2 on bad usage', () => {
  const script = join(REPO, 'tools/ci/evidence-check.ts');
  const head = git(repo, ['rev-parse', 'HEAD~1']); // the implementation commit, no evidence
  const failed = spawnSync(
    process.execPath,
    [script, '--pr', repo, '--base', base, '--head', head, '--head-ref', 'task/B2-01a', '--json'],
    { encoding: 'utf8' },
  );
  expect(failed.status).toBe(1);
  expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, risk: 'RV2' });
  const usage = spawnSync(process.execPath, [script, '--pr', repo], { encoding: 'utf8' });
  expect(usage.status).toBe(2);
});

/** A branch from the base with one commit writing `files`; returns its head. */
function branchFromBase(name: string, files: Record<string, string>): string {
  git(repo, ['checkout', '-q', '-b', name, base]);
  write(repo, files);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', name]);
  const head = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-q', 'task/B2-01a']);
  return head;
}

const approved = (head: string) => ({
  label: `owner-approved-${head.slice(0, 12)}`,
  approved: true,
  actor: 'o',
  reason: `label \`owner-approved-${head.slice(0, 12)}\` added by the owner account o`,
});

it('owner waiver: a non-task RV2 branch outside the money paths passes with a valid approval', () => {
  const head = branchFromBase('chore/gate-fix', { 'tools/guard/new-guard.ts': 'export {};\n' });
  const input = { prDir: repo, base, head, headRef: 'chore/gate-fix', trusted: REPO };
  const waived = checkEvidence({ ...input, approval: approved(head) });
  expect(waived).toMatchObject({ ok: true, risk: 'RV2', task: null, waivable: true, waived: true });
  expect(waived.notices.join('\n')).toContain('evidence file waived by the owner approval');

  const noApproval = checkEvidence(input);
  expect(noApproval).toMatchObject({ ok: false, waivable: true, waived: false });
  expect(noApproval.notices.join('\n')).toContain('looked up only with --pr-number');

  const refused = checkEvidence({
    ...input,
    approval: { ...approved(head), approved: false, actor: 'ci-bot', reason: 'added by `ci-bot`' },
  });
  expect(refused).toMatchObject({ ok: false, waived: false });
  expect(refused.problems.join('\n')).toContain('owner approval: no (added by `ci-bot`)');
});

it('owner waiver: touching a money / attribution implementation path still needs evidence', () => {
  const cases: [string, Record<string, string>][] = [
    ['chore/money', { 'packages/money/src/index.ts': 'export const a = 3;\n' }],
    ['chore/domain', { 'packages/domain/src/period.ts': 'export {};\n' }],
    ['chore/ledger', { 'apps/api/src/modules/ledger/post.ts': 'export {};\n' }],
    ['chore/union', { 'apps/api/src/modules/union/adapter.ts': 'export {};\n' }],
    ['chore/migration', { 'db/migrations/0002_x.sql': 'select 1;\n' }],
  ];
  for (const [branch, files] of cases) {
    const head = branchFromBase(branch, { 'tools/x.ts': 'export {};\n', ...files });
    const report = checkEvidence({
      prDir: repo,
      base,
      head,
      headRef: branch,
      trusted: REPO,
      approval: approved(head),
    });
    expect(report, branch).toMatchObject({ ok: false, waivable: false, waived: false });
    expect(report.money_paths, branch).toEqual(Object.keys(files));
    expect(report.problems.join('\n'), branch).toContain(
      'an owner approval label does not waive the evidence file',
    );
  }
  // A module that is not on the list (here: identity) is waivable.
  const identity = branchFromBase('chore/identity', {
    'apps/api/src/modules/identity/index.ts': 'export {};\n',
  });
  expect(
    checkEvidence({
      prDir: repo,
      base,
      head: identity,
      headRef: 'chore/identity',
      trusted: REPO,
      approval: approved(identity),
    }),
  ).toMatchObject({ ok: true, waived: true, money_paths: [] });
});

it('owner waiver: task branches are unchanged', () => {
  const head = git(repo, ['rev-parse', 'task/B2-01a~1']); // the implementation, no evidence
  const report = checkEvidence({
    prDir: repo,
    base,
    head,
    headRef: 'task/B2-01a',
    trusted: REPO,
    approval: approved(head),
  });
  expect(report).toMatchObject({ ok: false, task: 'B2-01a', waivable: false, waived: false });
  expect(report.problems.join('\n')).toContain('without ops/evidence/B2-01a.json');
});

it('the CLI looks the approval up with --pr-number, exactly like the protected-paths workflow', () => {
  const head = branchFromBase('chore/cli-waiver', { 'tools/y.ts': 'export {};\n' });
  const script = join(REPO, 'tools/ci/evidence-check.ts');
  const run = (labels: string[], labeledBy = 'o', liveHead = head) => {
    const routes = join(SCRATCH, `routes-${labels.join('-')}-${labeledBy}-${liveHead}.json`);
    writeFileSync(
      routes,
      JSON.stringify({
        '/repos/o/r/pulls/7': {
          status: 200,
          body: { head: { sha: liveHead }, labels: labels.map((name) => ({ name })) },
        },
        '/repos/o/r/issues/7/events?per_page=100&page=1': {
          status: 200,
          body: labels.map((name) => ({
            event: 'labeled',
            label: { name },
            actor: { login: labeledBy },
          })),
        },
      }),
    );
    const res = spawnSync(
      process.execPath,
      [
        '--import',
        join(REPO, 'tools/ci/testing/fake-github.ts'),
        script,
        '--pr',
        repo,
        '--base',
        base,
        '--head',
        head.slice(0, 12),
        '--head-ref',
        'chore/cli-waiver',
        '--pr-number',
        '7',
        '--json',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          COULI_FAKE_GITHUB: routes,
          GITHUB_API_URL: 'https://api.github.invalid',
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_REPOSITORY_OWNER: 'o',
          GH_TOKEN: 'not-a-real-token',
        },
      },
    );
    return { status: res.status, report: JSON.parse(res.stdout) as Record<string, unknown> };
  };
  const label = `owner-approved-${head.slice(0, 12)}`;
  expect(run([label])).toMatchObject({ status: 0, report: { ok: true, waived: true } });
  expect(run([`owner-approved-${base.slice(0, 12)}`])).toMatchObject({
    status: 1,
    report: { ok: false, waived: false },
  });
  expect(run([label], 'ci-bot')).toMatchObject({ status: 1, report: { ok: false } });
  expect(run([label], 'o', 'e'.repeat(40))).toMatchObject({ status: 1, report: { ok: false } });
});

it('[RO2-05, RO3-01] a CI run stays valid when only the evidence file is committed after it', () => {
  git(repo, ['checkout', '-q', 'task/B2-01a']);
  git(repo, ['checkout', '-q', '-b', 'ci-runs']);
  try {
    const tested = git(repo, ['rev-parse', 'HEAD']);
    const path = 'ops/evidence/B2-01a.json';
    const tree = headTreeWithoutEvidence(repo, tested, path) ?? '';
    const money = git(repo, ['rev-parse', `${tested}:packages/money`]);
    const ciRun = (extra: Evidence = {}): Evidence => ({
      mode: 'ci',
      commit: tested,
      spec_commit: specCommit,
      run_attempt: 1,
      conclusion: 'success',
      skipped: 0,
      exit_code: 0,
      ...extra,
    });
    const doc = (run: Evidence): Evidence =>
      evidence({
        runs: [{ mode: 'container', exit_code: 0, commit: tested, tree, prop_seed: 1 }, run],
        trees: { 'packages/money': money },
        longrun: { runs: 1000000, seed: 1, passed: true, tree: money },
      });
    // The evidence is committed after the CI run: the tested commit is an ancestor of the head
    // and differs from it by the evidence file only.
    const head = commitEvidence(doc(ciRun()));
    expect(head).not.toBe(tested);
    expect(check(head).problems).toEqual([]);

    // Not a clean single attempt, or not bound to the rule-test commit: refused.
    const cfg = loadProtected(REPO);
    const problemsOf = (run: Evidence): string =>
      evidenceProblems(doc(run), { prDir: repo, head, task: 'B2-01a', cfg }).join('\n');
    expect(problemsOf(ciRun({ run_attempt: 2 }))).toContain('run_attempt: must be 1');
    expect(problemsOf(ciRun({ conclusion: 'failure' }))).toContain('conclusion: must be success');
    expect(problemsOf(ciRun({ skipped: 1 }))).toContain('skipped: must be 0');
    expect(problemsOf(ciRun({ spec_commit: base }))).toContain('bound to the evidence spec_commit');
    expect(problemsOf(ciRun({ commit: tested.slice(0, 12) }))).toContain('full commit SHA');
    expect(problemsOf({ mode: 'browser', exit_code: 0, tree })).toContain(
      'must be container, host or ci',
    );
  } finally {
    git(repo, ['checkout', '-q', 'task/B2-01a']);
  }
});

it('[RO3-01] a CI run no longer counts once sources change after it', () => {
  git(repo, ['checkout', '-q', 'ci-runs']);
  try {
    const head0 = git(repo, ['rev-parse', 'HEAD']);
    const doc = JSON.parse(git(repo, ['show', `${head0}:ops/evidence/B2-01a.json`])) as Evidence;
    // A source file changes after the CI run; the evidence file is carried over unchanged.
    write(repo, { 'docs/README.md': '# docs, changed after the CI run\n' });
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'change after ci']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    const cfg = loadProtected(REPO);
    const problems = evidenceProblems(doc, { prDir: repo, head, task: 'B2-01a', cfg }).join('\n');
    expect(problems).toMatch(
      /runs\[1\]: commit: the tested tree [0-9a-f]+ differs from the head tree/,
    );
    expect(check(head).ok).toBe(false);
  } finally {
    git(repo, ['checkout', '-q', 'task/B2-01a']);
  }
});
