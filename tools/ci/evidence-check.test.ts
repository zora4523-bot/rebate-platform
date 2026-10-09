// evidence-check.ts against a fixture repository: an RV2 branch with and without a complete
// evidence file, an RV0 branch, and each field that must make the check fail.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CI_REFUSED,
  checkEvidence,
  evidenceProblems,
  handoverPolicy,
  headTreeWithoutEvidence,
  redRequirement,
} from './evidence-check.ts';
import type { HandoverPolicy } from './evidence-check.ts';
import { loadProtected } from '../guard/lib/protected.ts';
import { loadRiskMap } from '../guard/lib/risk.ts';

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
let specTree = '';
/** Trusted root of the fixture: risk map and protected paths of this repository, plus a ledger of
 * B2-01a written under the default split of 2026-10-05 (tester codex, test_paths) and an empty
 * switch-baseline list, so the red run is required (CR2-05). */
let TRUSTED = '';
const FLOOR = 'test/spec/money/floor.test.ts';
const RED = { required: true, expected: [FLOOR] };
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
    runs: [
      {
        mode: 'container',
        script: 'red',
        exit_code: 0,
        commit: null,
        tree: specTree,
        prop_seed: 1,
        red_tests: [`${FLOOR} > floors`],
        expected: [FLOOR],
      },
      {
        mode: 'container',
        script: 'verify',
        exit_code: 0,
        commit: null,
        tree: headTree,
        prop_seed: 1,
      },
    ],
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
  specTree = git(repo, ['rev-parse', `${specCommit}^{tree}`]);
  TRUSTED = join(SCRATCH, 'trusted');
  for (const file of ['tools/guard/protected-paths.json', 'ops/risk-map.yaml']) {
    write(TRUSTED, { [file]: readFileSync(join(REPO, file), 'utf8') });
  }
  write(TRUSTED, {
    'tools/guard/legacy-tasks.json': JSON.stringify({ baseline: 'fixture', tasks: [] }),
    'ops/tasks/B2-01a.yaml': [
      'id: B2-01a',
      'repo: rebate-platform',
      'title: money fixture',
      'type: impl',
      'refs: []',
      'refs_hash: {}',
      'deps: []',
      'paths:',
      "  - 'packages/money/src/**'",
      'test_paths:',
      "  - 'test/spec/money/**'",
      'impl: claude',
      'tester: codex',
      'accept:',
      "  - 'pnpm verify'",
      'status: todo',
      'pr: null',
      '',
    ].join('\n'),
  });
  write(repo, { 'packages/money/src/index.ts': 'export const a = 2;\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'impl (handover, Codex)']);
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function check(head: string, headRef = 'task/B2-01a') {
  return checkEvidence({ prDir: repo, base, head, headRef, trusted: TRUSTED });
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
    evidenceProblems(doc, { prDir: repo, head, task: 'B2-01a', cfg, red: RED }).join('\n');
  const otherTree = git(repo, ['rev-parse', `${base}^{tree}`]);
  const cases: [string, Evidence | string, RegExp][] = [
    ['task', evidence({ task: 'B2-02' }), /task: must be "B2-01a"/],
    ['spec_ref', evidence({ spec_ref: 'd'.repeat(40) }), /spec_ref: differs from SPEC_REF/],
    ['spec_commit not an ancestor', evidence({ spec_commit: 'e'.repeat(40) }), /not an ancestor/],
    [
      'host run',
      evidence({ runs: [{ mode: 'host', exit_code: 0, tree: headTree }] }),
      /host results are not accepted/,
    ],
    [
      'failed run',
      evidence({ runs: [{ mode: 'container', script: 'verify', exit_code: 1, tree: headTree }] }),
      /a listed container verify run must have exit code 0/,
    ],
    [
      'other tree',
      evidence({ runs: [{ mode: 'container', script: 'verify', exit_code: 0, tree: otherTree }] }),
      /a listed container verify run must have exit code 0/,
    ],
    ['runs not a list', evidence({ runs: 'ci' }), /runs: must be a list/],
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

it('[CR-09] after a handover the evidence names the handover commit and only the Claude review of it must pass', () => {
  const head = git(repo, ['rev-parse', 'HEAD']); // the evidence commit
  const impl = git(repo, ['rev-list', '--reverse', `${specCommit}..${head}`]).split('\n')[0]!;
  const cfg = loadProtected(REPO);
  const allowed: HandoverPolicy = {
    allowed: true,
    reason: 'task risk RV1',
    paths: ['packages/money/src/**'],
  };
  const problemsOf = (
    doc: unknown,
    opts: { handover?: HandoverPolicy | undefined; at?: string } = {},
  ): string => {
    const policy = 'handover' in opts ? opts.handover : allowed;
    return evidenceProblems(doc, {
      prDir: repo,
      head: opts.at ?? head,
      task: 'B2-01a',
      cfg,
      red: RED,
      ...(policy === undefined ? {} : { handover: policy }),
    }).join('\n');
  };
  const codexBefore = {
    reviewer: 'codex',
    verdict: 'fail',
    open_s0_s1: 1,
    checklist_complete: true,
  };
  const claudePass = {
    reviewer: 'claude',
    verdict: 'pass',
    open_s0_s1: 0,
    checklist_complete: true,
    commit: impl,
  };
  const handover = {
    implementer: 'codex',
    commit: impl,
    note: 'Opus implementation rounds used up',
  };

  // Without a handover both reviews must pass.
  expect(problemsOf(evidence({ reviews: [claudePass, codexBefore] }))).toMatch(
    /reviews.codex.verdict: must be pass/,
  );
  // With a valid handover the earlier Codex review is not checked; the Claude review of the
  // handover commit (or of a later ancestor of the head) still is.
  for (const commit of [impl, head]) {
    expect(
      problemsOf(evidence({ handover, reviews: [{ ...claudePass, commit }, codexBefore] })),
    ).toBe('');
  }
  expect(problemsOf(evidence({ handover, reviews: [codexBefore] }))).toMatch(
    /reviews: missing the claude review of the handover implementation/,
  );
  // A Claude review not bound to the handover commit (none, or from before it) does not count.
  const unbound = { reviewer: 'claude', verdict: 'pass', open_s0_s1: 0, checklist_complete: true };
  for (const review of [unbound, { ...claudePass, commit: specCommit }]) {
    expect(problemsOf(evidence({ handover, reviews: [review, codexBefore] }))).toMatch(
      /reviews: missing the claude review of the handover implementation/,
    );
  }
  expect(
    problemsOf(
      evidence({ handover, reviews: [{ ...claudePass, verdict: 'fail', open_s0_s1: 1 }] }),
    ),
  ).toMatch(/reviews.claude.verdict: must be pass[\s\S]*reviews.claude.open_s0_s1: must be 0/);
  // Every bound Claude review counts (a failing later round fails), spec-test reviews do not, and
  // the Claude review carries the funds checklist the Codex one carried.
  expect(
    problemsOf(
      evidence({
        handover,
        reviews: [claudePass, { ...claudePass, commit: head, verdict: 'fail' }, codexBefore],
      }),
    ),
  ).toMatch(/reviews.claude.verdict: must be pass/);
  expect(
    problemsOf(evidence({ handover, reviews: [{ ...claudePass, review_type: 'spec-test' }] })),
  ).toMatch(/reviews: missing the claude review of the handover implementation/);
  const noChecklist = { ...claudePass, checklist_complete: false };
  expect(problemsOf(evidence({ handover, reviews: [noChecklist, codexBefore] }))).toMatch(
    /reviews.claude.checklist_complete: must be true after a handover/,
  );

  // RV2 不换家: without an allowing policy the handover is refused and both reviews stay required.
  for (const policy of [
    undefined,
    { allowed: false, reason: 'the task ledger paths are RV2', paths: allowed.paths },
  ]) {
    const text = problemsOf(evidence({ handover, reviews: [claudePass, codexBefore] }), {
      handover: policy,
    });
    expect(text).toMatch(/handover: not allowed: .*RV2 不换家/);
    expect(text).toMatch(/reviews.codex.verdict: must be pass/);
  }

  // A commit mixing ledger and other paths, and a merge commit, on a side branch.
  git(repo, ['checkout', '-q', '-b', 'handover-shapes', head]);
  write(repo, {
    'packages/money/src/index.ts': 'export const a = 3;\n',
    'docs/README.md': '# x\n',
  });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'mixed']);
  const mixed = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-q', '-b', 'handover-side', impl]);
  write(repo, { 'packages/money/src/side.ts': 'export {};\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'side']);
  git(repo, ['checkout', '-q', 'handover-shapes']);
  const side = git(repo, ['rev-parse', 'handover-side']);
  git(repo, ['merge', '-q', '--no-ff', '-m', 'merge', 'handover-side']);
  const merge = git(repo, ['rev-parse', 'HEAD']);
  write(repo, { 'packages/money/src/index.ts': 'export const a = 4;\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'an Opus fix']);
  const unmarked = git(repo, ['rev-parse', 'HEAD']);
  const ledgerCommit = (ledger: string): string => {
    write(repo, {
      'packages/money/src/index.ts': `export const a = '${ledger}';\n`,
      [ledger]: 'id: x\n',
    });
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `with ${ledger} (handover, Codex)`]);
    return git(repo, ['rev-parse', 'HEAD']);
  };
  const ownLedger = ledgerCommit('ops/tasks/B2-01a.yaml');
  const otherLedger = ledgerCommit('ops/tasks/B9-01a.yaml');
  git(repo, ['checkout', '-q', 'task/B2-01a']);

  // The handover commit may also change the task's own ledger file, no other one.
  const at = (commit: string): string =>
    problemsOf(
      evidence({ handover: { ...handover, commit }, reviews: [{ ...claudePass, commit }] }),
      { at: commit },
    );
  expect(at(ownLedger)).not.toMatch(/handover|reviews/);
  expect(at(otherLedger)).toMatch(
    /handover.commit: .* changes paths outside the task ledger: ops\/tasks\/B9-01a.yaml/,
  );

  // A Claude review of a commit off the head's history does not count; a change after the review
  // other than the task's evidence and ledger files fails.
  expect(problemsOf(evidence({ handover, reviews: [{ ...claudePass, commit: side }] }))).toMatch(
    /reviews: missing the claude review of the handover implementation/,
  );
  expect(problemsOf(evidence({ handover, reviews: [claudePass] }), { at: mixed })).toMatch(
    /reviews.claude.commit: changed after the Claude review .*: docs\/README.md, packages\/money\/src\/index.ts/,
  );

  // The handover commit must be a single-parent implementation commit after the rule-test commit
  // on the head, changing paths of the task ledger only; any defect falls back to both reviews.
  const cases: [unknown, RegExp][] = [
    [{ ...handover, commit: specCommit }, /handover.commit: .* is not after the rule-test commit/],
    [{ ...handover, commit: base }, /handover.commit: .* is not after the rule-test commit/],
    [
      { ...handover, commit: 'not-a-sha' },
      /handover.commit: must be the handover implementation commit id/,
    ],
    [{ ...handover, commit: 'f'.repeat(40) }, /handover.commit: .* is not an ancestor of the head/],
    [
      { ...handover, commit: head },
      /handover.commit: .* changes no implementation path of the task ledger/,
    ],
    [
      { ...handover, commit: mixed },
      /handover.commit: .* changes paths outside the task ledger: docs\/README.md/,
    ],
    [{ ...handover, commit: merge }, /handover.commit: .* must be a single-parent commit/],
    [{ ...handover, commit: unmarked }, /handover.commit: .* does not carry the handover marker/],
    [{ ...handover, implementer: 'claude' }, /handover.implementer: must be "codex"/],
    [{ ...handover, note: ' ' }, /handover.note: must say why/],
    ['codex', /handover: must be an object/],
  ];
  for (const [value, pattern] of cases) {
    const reviews = [{ ...claudePass, commit: unmarked }, codexBefore];
    const text = problemsOf(evidence({ handover: value, reviews }), { at: unmarked });
    expect(text, JSON.stringify(value)).toMatch(pattern);
    expect(text, JSON.stringify(value)).toMatch(/reviews.codex.verdict: must be pass/);
  }
});

it('[CR-09] checkEvidence refuses a handover on a money task and accepts one on an RV1 task', () => {
  // Money task (packages/money/src/**, RV2): a handover record never replaces the Codex review.
  const impl = git(repo, ['rev-list', '--reverse', `${specCommit}..task/B2-01a`]).split('\n')[0]!;
  git(repo, ['checkout', '-q', '-b', 'handover-money', 'task/B2-01a']);
  const moneyHead = commitEvidence(
    evidence({
      handover: { implementer: 'codex', commit: impl, note: 'rounds used up' },
      reviews: [
        {
          reviewer: 'claude',
          verdict: 'pass',
          open_s0_s1: 0,
          checklist_complete: true,
          commit: impl,
        },
      ],
    }),
  );
  git(repo, ['checkout', '-q', 'task/B2-01a']);
  const money = check(moneyHead);
  expect(money).toMatchObject({ ok: false, risk: 'RV2' });
  expect(money.problems.join('\n')).toMatch(/handover: not allowed: the task ledger paths are RV2/);
  expect(money.problems.join('\n')).toMatch(/missing the codex review/);

  // RV1 task (packages/evals/**): rule-test commit, Codex handover implementation, evidence.
  write(TRUSTED, {
    'ops/tasks/B3-01z.yaml': [
      'id: B3-01z',
      'repo: rebate-platform',
      'title: evals fixture',
      'type: impl',
      'refs: []',
      'refs_hash: {}',
      'deps: []',
      'paths:',
      "  - 'packages/evals/**'",
      'test_paths:',
      "  - 'test/spec/evals-z/**'",
      'impl: claude',
      'tester: codex',
      'accept:',
      "  - 'pnpm verify'",
      'status: todo',
      'pr: null',
      '',
    ].join('\n'),
  });
  const GATE = 'test/spec/evals-z/gate.test.ts';
  git(repo, ['checkout', '-q', '-b', 'task/B3-01z', base]);
  write(repo, { [GATE]: 'it("gates", () => {});\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'test(spec): gate']);
  const spec = git(repo, ['rev-parse', 'HEAD']);
  write(repo, { 'packages/evals/src/index.ts': 'export const gate = 1;\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'impl (handover, Codex)']);
  const handoverCommit = git(repo, ['rev-parse', 'HEAD']);
  const evalsTree = git(repo, ['rev-parse', 'HEAD:packages/evals']);
  const claude = {
    reviewer: 'claude',
    verdict: 'pass',
    open_s0_s1: 0,
    checklist_complete: true,
    commit: handoverCommit,
  };
  const doc = (reviews: unknown[]) => ({
    task: 'B3-01z',
    spec_ref: SPEC_REF,
    spec_commit: spec,
    red_tests: ['gates'],
    runs: [
      {
        mode: 'container',
        script: 'red',
        exit_code: 0,
        commit: null,
        tree: git(repo, ['rev-parse', `${spec}^{tree}`]),
        prop_seed: 1,
        red_tests: [`${GATE} > gates`],
        expected: [GATE],
      },
    ],
    reviews,
    handover: { implementer: 'codex', commit: handoverCommit, note: 'rounds used up' },
    trees: { 'packages/evals': evalsTree },
    longrun: { runs: 1000000, seed: 1, passed: true, tree: evalsTree },
  });
  const commitDoc = (value: unknown): string => {
    write(repo, { 'ops/evidence/B3-01z.json': `${JSON.stringify(value, null, 2)}\n` });
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'evidence']);
    return git(repo, ['rev-parse', 'HEAD']);
  };
  const codexFail = { reviewer: 'codex', verdict: 'fail', open_s0_s1: 1 };
  const good = check(commitDoc(doc([claude, codexFail])), 'task/B3-01z');
  expect(good.problems).toEqual([]);
  // The rule tests make the pull request RV2, so the Claude review carries the checklist.
  expect(good).toMatchObject({ ok: true, risk: 'RV2', task: 'B3-01z' });
  const noChecklist = check(
    commitDoc(doc([{ ...claude, checklist_complete: false }, codexFail])),
    'task/B3-01z',
  );
  expect(noChecklist.problems.join('\n')).toMatch(/reviews.claude.checklist_complete/);
  git(repo, ['checkout', '-q', 'task/B2-01a']);

  // Variants on top of the handover commit, each with the same evidence.
  const variant = (name: string, files: Record<string, string>) => {
    git(repo, ['checkout', '-q', '-b', name, handoverCommit]);
    write(repo, files);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', name]);
    const head = commitDoc(doc([claude, codexFail]));
    git(repo, ['checkout', '-q', 'task/B2-01a']);
    return check(head, 'task/B3-01z').problems.join('\n');
  };
  // A money / attribution path changed (RV2 不换家) refuses the handover.
  const moneyVariant = variant('b3z-money', { 'packages/money/src/m.ts': 'export {};\n' });
  expect(moneyVariant).toMatch(
    /handover: not allowed: money \/ attribution implementation paths changed/,
  );
  expect(moneyVariant).toMatch(/reviews.codex.verdict: must be pass/);
  // So does any other RV2 path outside the rule tests, the task's own files and docs.
  expect(variant('b3z-db', { 'packages/db/src/x.ts': 'export {};\n' })).toMatch(
    /handover: not allowed: changed paths are RV2 \(packages\/db\/src\/x.ts\)/,
  );
  // A change after the bound Claude review fails.
  expect(
    variant('b3z-later', { 'packages/evals/src/index.ts': 'export const gate = 2;\n' }),
  ).toMatch(
    /reviews.claude.commit: changed after the Claude review .*: packages\/evals\/src\/index.ts/,
  );
  // The ledger comes from the trusted root: the head rewriting it changes nothing.
  const rewritten = readFileSync(join(TRUSTED, 'ops/tasks/B3-01z.yaml'), 'utf8').replace(
    'packages/evals/**',
    'packages/db/**',
  );
  expect(variant('b3z-ledger', { 'ops/tasks/B3-01z.yaml': rewritten })).toBe('');
  // An unreadable ledger refuses the handover.
  const unreadable = handoverPolicy(
    { prDir: repo, base, head: handoverCommit, headRef: 'task/B3-01y', trusted: TRUSTED },
    'B3-01y',
    ['packages/evals/src/index.ts'],
    loadRiskMap(TRUSTED),
    loadProtected(TRUSTED),
  );
  expect(unreadable).toMatchObject({
    allowed: false,
    reason: 'ops/tasks/B3-01y.yaml could not be read',
  });
});

it('rule tests changed after the rule-test commit fail the check', () => {
  git(repo, ['checkout', '-q', '-b', 'task/B2-01b', 'task/B2-01a']);
  write(repo, { 'test/spec/money/floor.test.ts': 'it("floors differently", () => {});\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'weaken the rule test']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const problems = evidenceProblems(evidence(), {
    prDir: repo,
    head,
    task: 'B2-01a',
    cfg,
    red: RED,
  });
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
  const input = { prDir: repo, base, head, headRef: 'chore/gate-fix', trusted: TRUSTED };
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
      trusted: TRUSTED,
      approval: approved(head),
    });
    expect(report, branch).toMatchObject({ ok: false, waivable: false, waived: false });
    expect(report.money_paths, branch).toEqual(Object.keys(files));
    expect(report.problems.join('\n'), branch).toContain(
      'an owner approval label does not waive the evidence file',
    );
  }
  // A module that is not on the list and not in the risk map (here: growth) is waivable.
  // (identity, catalog, then notification, were the example until they got their own RV1 entries in ops/risk-map.yaml.)
  const growth = branchFromBase('chore/growth', {
    'apps/api/src/modules/growth/index.ts': 'export {};\n',
  });
  expect(
    checkEvidence({
      prDir: repo,
      base,
      head: growth,
      headRef: 'chore/growth',
      trusted: TRUSTED,
      approval: approved(growth),
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
    trusted: TRUSTED,
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

it('[CR-02] a verify:fast record never stands in for the full verification', () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const problemsOf = (doc: unknown): string =>
    evidenceProblems(doc, { prDir: repo, head, task: 'B2-01a', cfg, red: RED }).join('\n');
  // Fast passed on the very tree, the full verification never ran: refused.
  const fastOnly = problemsOf(
    evidence({
      runs: [{ mode: 'container', script: 'verify:fast', exit_code: 0, tree: headTree }],
    }),
  );
  expect(fastOnly).toContain("verify:fast is the implementer's own check");
  // Fast passed, a listed full verification failed: refused.
  expect(
    problemsOf(
      evidence({
        runs: [
          { mode: 'container', script: 'verify:fast', exit_code: 0, tree: headTree },
          { mode: 'container', script: 'verify', exit_code: 1, tree: headTree },
        ],
      }),
    ),
  ).toContain('a listed container verify run must have exit code 0');
  // A record without a script cannot prove which one ran.
  expect(
    problemsOf(evidence({ runs: [{ mode: 'container', exit_code: 0, tree: headTree }] })),
  ).toContain('must be verify or red');
});

it('[CR2-06] CI records are refused until the CI evidence archive is connected', () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const ci = {
    mode: 'ci',
    phase: 'green',
    run_id: 102,
    run_url: 'https://github.com/o/r/actions/runs/102',
    run_attempt: 1,
    workflow: 'browser',
    job: 'playwright',
    commit: head,
    tree: headTree,
    report_sha256: 'a'.repeat(64),
    spec_commit: specCommit,
    conclusion: 'success',
    skipped: 0,
    exit_code: 0,
  };
  const doc = evidence();
  const problems = evidenceProblems(
    { ...doc, runs: [...(doc['runs'] as Evidence[]), ci] },
    { prDir: repo, head, task: 'B2-01a', cfg, red: RED },
  );
  expect(problems).toEqual([`runs[2].mode: ${CI_REFUSED}`]);
  expect(CI_REFUSED).toContain('CI 证据归档未接入，暂不接受');
});

it('[CR2-05] a task whose rule tests Codex writes needs a valid red run covering its new rule tests', () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const cfg = loadProtected(REPO);
  const problemsOf = (runs: Evidence[], red = RED): string =>
    evidenceProblems(evidence({ runs }), { prDir: repo, head, task: 'B2-01a', cfg, red }).join(
      '\n',
    );
  const [redRun, verifyRun] = evidence()['runs'] as [Evidence, Evidence];
  expect(problemsOf([redRun, verifyRun])).toBe('');
  // The red run left out: "never red, straight to green" is refused.
  expect(problemsOf([verifyRun])).toContain('no valid red run');
  // A red run that failed red-check, ran on another tree, or skipped a new rule-test file.
  expect(problemsOf([{ ...redRun, exit_code: 1 }, verifyRun])).toContain('red-check passed');
  expect(problemsOf([{ ...redRun, tree: headTree }, verifyRun])).toContain(
    'must have run on the spec_commit tree',
  );
  expect(problemsOf([{ ...redRun, expected: [] }, verifyRun])).toContain(`does not cover ${FLOOR}`);
  expect(
    problemsOf([{ ...redRun, red_tests: ['test/spec/money/round.test.ts > rounds'] }, verifyRun]),
  ).toContain(`no red test of ${FLOOR}`);
  // Required, but the task added no rule-test file at all.
  expect(problemsOf([redRun, verifyRun], { required: true, expected: [] })).toContain(
    'the task added no rule-test file',
  );
  // Not required for a ledger of the switch baseline.
  expect(problemsOf([verifyRun], { required: false, expected: [] })).toBe('');
});

it('[CR2-05] the requirement comes from the trusted ledger and the switch-baseline list', () => {
  const head = git(repo, ['rev-parse', 'HEAD']);
  const text = JSON.stringify({ task: 'B2-01a', spec_commit: specCommit });
  const input = { prDir: repo, base, head, headRef: 'task/B2-01a', trusted: TRUSTED };
  expect(redRequirement(input, 'B2-01a', base, text)).toEqual({
    required: true,
    expected: [FLOOR],
  });
  // The real repository lists B2-01a among the switch-baseline ledgers (written by Claude).
  expect(redRequirement({ ...input, trusted: REPO }, 'B2-01a', base, text)).toEqual({
    required: false,
    expected: [],
  });
  // CR3-03: a new task with tester: claude is not exempt; only tester none or a legacy ledger.
  const claudeTrusted = join(SCRATCH, 'trusted-claude-tester');
  for (const file of [
    'tools/guard/protected-paths.json',
    'ops/risk-map.yaml',
    'tools/guard/legacy-tasks.json',
  ]) {
    write(claudeTrusted, { [file]: readFileSync(join(TRUSTED, file), 'utf8') });
  }
  write(claudeTrusted, {
    'ops/tasks/B2-01a.yaml': readFileSync(join(TRUSTED, 'ops/tasks/B2-01a.yaml'), 'utf8')
      .replace('impl: claude', 'impl: codex')
      .replace('tester: codex', 'tester: claude'),
  });
  expect(redRequirement({ ...input, trusted: claudeTrusted }, 'B2-01a', base, text)).toEqual({
    required: true,
    expected: [FLOOR],
  });
  // An unreadable ledger requires the red run with nothing to cover: fails closed.
  expect(redRequirement(input, 'B9-99', base, text)).toEqual({ required: true, expected: [] });
  // The full check: evidence without the red run fails.
  const doc = evidence();
  const runs = doc['runs'] as Evidence[];
  const noRed = commitEvidence({ ...doc, runs: runs.slice(1) });
  expect(check(noRed).problems.join('\n')).toContain('no valid red run');
});

it('[legacy flow] a legacy ledger needs no red run and no test_paths, but still the full container verify', () => {
  // A B1-01s-shape ledger: Codex implements, Claude wrote the rule tests, no test_paths; listed
  // on the trusted legacy list.
  const legacyTrusted = join(SCRATCH, 'trusted-legacy');
  for (const file of ['tools/guard/protected-paths.json', 'ops/risk-map.yaml']) {
    write(legacyTrusted, { [file]: readFileSync(join(REPO, file), 'utf8') });
  }
  write(legacyTrusted, {
    'tools/guard/legacy-tasks.json': JSON.stringify({ baseline: 'fixture', tasks: ['B2-01a'] }),
    'ops/tasks/B2-01a.yaml': readFileSync(join(TRUSTED, 'ops/tasks/B2-01a.yaml'), 'utf8')
      .replace('impl: claude', 'impl: codex')
      .replace('tester: codex', 'tester: claude')
      .replace("test_paths:\n  - 'test/spec/money/**'\n", ''),
  });
  const doc = evidence();
  const runs = doc['runs'] as Evidence[];
  const head = commitEvidence({ ...doc, runs: runs.slice(1) });
  const input = { prDir: repo, base, head, headRef: 'task/B2-01a', trusted: legacyTrusted };
  expect(checkEvidence(input).problems).toEqual([]);
  // The required CI checks are the full verification (ops/approvals.yaml id 21): no container
  // verify run is needed, an empty run list passes for a ledger without a red-run requirement.
  const noVerify = commitEvidence({ ...doc, runs: runs.slice(0, 1) });
  expect(checkEvidence({ ...input, head: noVerify }).problems).toEqual([]);
  const noRuns = commitEvidence({ ...doc, runs: [] });
  expect(checkEvidence({ ...input, head: noRuns }).problems).toEqual([]);
});
