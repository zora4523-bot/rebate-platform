// Tests for the output schemas and validate-output.ts (规划/11 §2.4 schema 写法, §3.1, §3.3).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AGENT_DIR, type Fixture, gitIn, makeFixture } from './testing/fixture.ts';
import {
  CHECKLIST_ITEMS,
  gitLineChecker,
  type LineChecker,
  outsideRefs,
  parseHunks,
  type ReviewOutput,
  reviewProblems,
  schemaErrors,
  validateOutput,
} from './validate-output.ts';

const IMPL_SCHEMA_FILE = join(AGENT_DIR, 'schemas', 'impl.schema.json');
const REVIEW_SCHEMA_FILE = join(AGENT_DIR, 'schemas', 'review.schema.json');
const implSchema: unknown = JSON.parse(readFileSync(IMPL_SCHEMA_FILE, 'utf8'));
const reviewSchema: unknown = JSON.parse(readFileSync(REVIEW_SCHEMA_FILE, 'utf8'));

const fixtures: Fixture[] = [];
afterEach(() => {
  for (const fx of fixtures.splice(0)) fx.cleanup();
});

function validImpl(): Record<string, unknown> {
  return {
    task_done: true,
    files_changed: ['packages/money/src/split.ts'],
    commands: [{ cmd: 'pnpm verify:fast', exit_code: 0 }],
    tests_passed: true,
    deps_needed: [],
    outside_needed: [{ cmd: 'pnpm db:migrate', reason: 'new migration' }],
    blocked_reason: '',
    notes: '',
  };
}

function validReview(file = 'src/a.ts', line = 1): ReviewOutput {
  return {
    verdict: 'fail',
    summary: 'Checked the split function against BR-CALC-21; one rounding defect.',
    findings: [
      {
        severity: 'S0',
        key: `${file}#split#BR-CALC-21`,
        file,
        line,
        rule: 'BR-CALC-21',
        scenario: 'base 101 fen at 5000 bp yields 51 instead of 50',
        suggestion: 'Use floor division.',
      },
    ],
    out_of_scope: [],
    checklist: CHECKLIST_ITEMS.map((item) => ({
      item,
      status: item === 'rounding' ? 'issue' : 'ok',
      file,
      line,
      note: `verified ${item}`,
    })),
  };
}

type SchemaNode = {
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: unknown;
  items?: SchemaNode;
  enum?: unknown[];
};

const ALLOWED_KEYWORDS = [
  'type',
  'enum',
  'properties',
  'items',
  'required',
  'additionalProperties',
];

/** Collects violations of the strict rule: closed objects, every property required. */
function strictRuleViolations(node: SchemaNode, path: string): string[] {
  const problems: string[] = [];
  for (const keyword of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.includes(keyword)) problems.push(`${path}: keyword ${keyword}`);
  }
  if (node.type === 'object') {
    if (node.additionalProperties !== false) problems.push(`${path}: additionalProperties`);
    const names = Object.keys(node.properties ?? {}).sort();
    if (JSON.stringify(names) !== JSON.stringify([...(node.required ?? [])].sort())) {
      problems.push(`${path}: required`);
    }
    for (const name of names) {
      problems.push(...strictRuleViolations(node.properties?.[name] ?? {}, `${path}.${name}`));
    }
  }
  if (node.items !== undefined) problems.push(...strictRuleViolations(node.items, `${path}[]`));
  return problems;
}

it('both schemas close every object and require every property', () => {
  expect(strictRuleViolations(implSchema as SchemaNode, 'impl')).toEqual([]);
  expect(strictRuleViolations(reviewSchema as SchemaNode, 'review')).toEqual([]);
});

it('schemas carry exactly the agreed fields', () => {
  const impl = implSchema as SchemaNode;
  expect(Object.keys(impl.properties ?? {})).toEqual([
    'task_done',
    'files_changed',
    'commands',
    'tests_passed',
    'deps_needed',
    'outside_needed',
    'blocked_reason',
    'notes',
  ]);
  const review = reviewSchema as SchemaNode;
  expect(Object.keys(review.properties ?? {})).toEqual([
    'verdict',
    'summary',
    'findings',
    'out_of_scope',
    'checklist',
  ]);
  expect(review.required).toEqual(['verdict', 'summary', 'findings', 'out_of_scope', 'checklist']);
  for (const list of ['findings', 'out_of_scope']) {
    const items = review.properties?.[list]?.items;
    expect(items?.additionalProperties).toBe(false);
    expect(items?.required).toEqual([
      'severity',
      'key',
      'file',
      'line',
      'rule',
      'scenario',
      'suggestion',
    ]);
    expect(Object.keys(items?.properties ?? {})).toEqual(items?.required);
  }
  const checklistItem = review.properties?.['checklist']?.items?.properties ?? {};
  expect(Object.keys(checklistItem)).toEqual(['item', 'status', 'file', 'line', 'note']);
  expect(checklistItem['item']?.enum).toEqual([...CHECKLIST_ITEMS]);
  expect(checklistItem['line']?.type).toBe('integer');
});

it('schemaErrors accepts valid outputs and names each violation', () => {
  expect(schemaErrors(implSchema, validImpl())).toEqual([]);
  expect(schemaErrors(reviewSchema, validReview())).toEqual([]);

  const extra = { ...validImpl(), surprise: 1 };
  expect(schemaErrors(implSchema, extra).join('\n')).toContain('additional properties');

  const missing = validImpl();
  delete missing['notes'];
  expect(schemaErrors(implSchema, missing).join('\n')).toContain("required property 'notes'");

  const wrongType = { ...validImpl(), commands: [{ cmd: 'x', exit_code: '0' }] };
  expect(schemaErrors(implSchema, wrongType).join('\n')).toContain('/commands/0/exit_code');

  const badEnum = { ...validReview(), verdict: 'maybe' };
  expect(schemaErrors(reviewSchema, badEnum).join('\n')).toContain('/verdict');
  const fractionalLine = validReview();
  (fractionalLine.findings[0] as { line: number }).line = 1.5;
  expect(schemaErrors(reviewSchema, fractionalLine).join('\n')).toContain('must be integer');
});

it('schemaErrors refuses a schema that strict mode does not accept', () => {
  expect(() => schemaErrors({ type: 'object', unknownKeyword: true }, {})).toThrow(/strict mode/);
});

it('parseHunks returns the new-side ranges, and the old side for pure deletions', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@ header',
    ' context',
    '+added',
    '@@ -20 +21 @@',
    '-old',
    '+new',
    '@@ -40,2 +41,0 @@',
    '-gone',
    '-gone too',
  ].join('\n');
  expect(parseHunks(diff)).toEqual([
    { start: 1, end: 4 },
    { start: 21, end: 21 },
    { start: 40, end: 41 },
  ]);
  expect(parseHunks('')).toEqual([]);
});

it('every finding needs a scenario, a file:line and a stable key', () => {
  expect(reviewProblems(validReview(), { money: false }).errors).toEqual([]);

  const review = validReview();
  const finding = review.findings[0];
  if (finding === undefined) throw new Error('fixture has no finding');
  finding.scenario = '  ';
  finding.line = 0;
  finding.key = 'src/other.ts#split';
  const errors = reviewProblems(review, { money: false }).errors.join('\n');
  expect(errors).toContain('findings[0]: scenario is empty');
  expect(errors).toContain('findings[0]: needs file and line >= 1');
  expect(errors).toContain('findings[0]: key must be "<file>#<function>#<rule id>"');

  const otherFile = validReview();
  const second = otherFile.findings[0];
  if (second === undefined) throw new Error('fixture has no finding');
  second.key = 'src/other.ts#split#BR-CALC-21';
  expect(reviewProblems(otherFile, { money: false }).errors.join('\n')).toContain(
    'key must start with the same path as "file"',
  );

  expect(
    reviewProblems({ ...validReview(), summary: '' }, { money: false }).errors.join('\n'),
  ).toContain('summary: empty');
});

it('a pass verdict next to S0/S1 findings is an error, not a usable output', () => {
  const result = reviewProblems({ ...validReview(), verdict: 'pass' }, { money: false });
  expect(result.warnings).toEqual([]);
  expect(result.errors.join('\n')).toContain('verdict is "pass" but 1 S0/S1');
  const s2Only = {
    ...validReview(),
    verdict: 'pass' as const,
    findings: validReview().findings.map((f) => ({ ...f, severity: 'S2' as const })),
  };
  expect(reviewProblems(s2Only, { money: false }).errors).toEqual([]);
});

it('[规划/11 §2.5] out_of_scope entries are checked like findings and never decide the verdict', () => {
  const finding = validReview().findings[0];
  if (finding === undefined) throw new Error('fixture has no finding');
  const elsewhere = {
    ...finding,
    key: 'src/a.ts#split#BR-FUND-03',
    rule: 'BR-FUND-03',
  };
  // An S0 outside the scope next to a pass verdict is fine: it does not count.
  const pass = {
    ...validReview(),
    verdict: 'pass' as const,
    findings: [],
    out_of_scope: [elsewhere],
  };
  expect(reviewProblems(pass, { money: false })).toEqual({ errors: [], warnings: [] });
  const sloppy = {
    ...pass,
    out_of_scope: [{ ...elsewhere, scenario: ' ', key: 'other.ts#x#BR-FUND-03' }, finding],
    findings: [{ ...finding, severity: 'S2' as const }],
  };
  const errors = reviewProblems(sloppy, { money: false }).errors.join('\n');
  expect(errors).toContain('out_of_scope[0]: scenario is empty');
  expect(errors).toContain('out_of_scope[0]: key must start with the same path as "file"');
  expect(errors).toContain(`out_of_scope[1]: key ${finding.key} is also listed in findings`);
});

it('[规划/11 §2.5] with --refs, findings about rules outside the refs do not count toward the verdict', () => {
  expect(outsideRefs('BR-FUND-03', ['BR-CALC-01'])).toEqual(['BR-FUND-03']);
  expect(outsideRefs('BR-CALC-01 via BR-FUND-03', ['BR-CALC-01'])).toEqual([]);
  expect(outsideRefs('mutation-floor-to-round', ['BR-CALC-01'])).toEqual([]);
  const finding = validReview().findings[0];
  if (finding === undefined) throw new Error('fixture has no finding');
  const misplaced = { ...finding, key: 'src/a.ts#split#BR-FUND-03', rule: 'BR-FUND-03' };
  const refs = ['BR-CALC-01', 'BR-CALC-08'];
  // A pass that only carries a misplaced S0 is not contradictory, but the misplacement is named.
  const pass = { ...validReview(), verdict: 'pass' as const, findings: [misplaced], checklist: [] };
  const passed = reviewProblems(pass, { money: false, refs });
  expect(passed.errors).toEqual([]);
  expect(passed.warnings.join('\n')).toContain(
    'findings[0]: rule cites BR-FUND-03, outside the task refs (BR-CALC-01, BR-CALC-08)',
  );
  // A fail that rests only on misplaced findings is flagged as a pass within the refs.
  const failed = reviewProblems({ ...pass, verdict: 'fail' }, { money: false, refs });
  expect(failed.warnings.join('\n')).toContain('within the refs this review is a pass');
  // Without --refs nothing changes: the pass is contradictory.
  expect(reviewProblems(pass, { money: false }).errors.join('\n')).toContain(
    'verdict is "pass" but 1 S0/S1',
  );
  // An in-scope S0 next to a pass stays an error with --refs.
  const inScope = { ...finding, key: 'src/a.ts#split#BR-CALC-01', rule: 'BR-CALC-01' };
  expect(
    reviewProblems({ ...pass, findings: [inScope] }, { money: false, refs }).errors.join('\n'),
  ).toContain('verdict is "pass" but 1 S0/S1');
});

it('money review: seven items exactly once, each with file:line and a note', () => {
  expect(reviewProblems(validReview(), { money: true }).errors).toEqual([]);
  // The checklist is only mandatory for money reviews.
  expect(reviewProblems({ ...validReview(), checklist: [] }, { money: false }).errors).toEqual([]);

  const empty = reviewProblems({ ...validReview(), checklist: [] }, { money: true }).errors;
  expect(empty).toHaveLength(7);
  expect(empty[0]).toContain('"rounding" must appear exactly once (found 0)');

  const duplicated = validReview();
  const first = duplicated.checklist[0];
  if (first === undefined) throw new Error('fixture has no checklist');
  duplicated.checklist.push({ ...first });
  expect(reviewProblems(duplicated, { money: true }).errors.join('\n')).toContain(
    '"rounding" must appear exactly once (found 2)',
  );

  const sloppy = validReview();
  const clock = sloppy.checklist.find((c) => c.item === 'clock');
  const appId = sloppy.checklist.find((c) => c.item === 'app_id');
  if (clock === undefined || appId === undefined) throw new Error('fixture has no checklist');
  clock.file = '';
  appId.note = ' ';
  const errors = reviewProblems(sloppy, { money: true }).errors.join('\n');
  expect(errors).toContain('(clock): needs file and line >= 1');
  expect(errors).toContain('(app_id): note is empty');

  const issueWithoutFinding = { ...validReview(), findings: [] };
  expect(reviewProblems(issueWithoutFinding, { money: true }).errors.join('\n')).toContain(
    'status "issue" but there is no finding',
  );
});

it('money review: every cited line is checked against the diff', () => {
  const onlyLineOne: LineChecker = (file, line) =>
    file === 'src/a.ts' && line === 1
      ? { ok: true, reason: '' }
      : { ok: false, reason: 'line is outside the diff hunks of this file' };
  expect(reviewProblems(validReview(), { money: true, lineChecker: onlyLineOne }).errors).toEqual(
    [],
  );
  const errors = reviewProblems(validReview('src/a.ts', 99), {
    money: true,
    lineChecker: onlyLineOne,
  }).errors;
  expect(errors).toHaveLength(7);
  expect(errors[0]).toContain('src/a.ts:99 line is outside the diff hunks of this file');
});

it('gitLineChecker follows the real diff of the worktree against the base', () => {
  const fx = makeFixture('linecheck');
  fixtures.push(fx);
  const lines = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`);
  writeFileSync(join(fx.worktree, 'src', 'big.ts'), `${lines.join('\n')}\n`);
  writeFileSync(join(fx.worktree, 'src', 'gone.ts'), 'export const gone = 1;\n');
  gitIn(fx.worktree, ['add', '.']);
  gitIn(fx.worktree, ['commit', '-q', '-m', 'more files']);
  const base = gitIn(fx.worktree, ['rev-parse', 'HEAD']);

  lines[29] = 'export const v29 = 2900;';
  writeFileSync(join(fx.worktree, 'src', 'big.ts'), `${lines.join('\n')}\n`);
  rmSync(join(fx.worktree, 'src', 'gone.ts'));
  mkdirSync(join(fx.worktree, 'src', '新目录'));
  writeFileSync(join(fx.worktree, 'src', '新目录', 'new.ts'), 'one\ntwo\nthree\n');

  const check = gitLineChecker(base, fx.worktree);
  expect(check('src/big.ts', 30)).toEqual({ ok: true, reason: '' });
  expect(check('src/big.ts', 27).ok).toBe(true); // context line of the hunk
  expect(check('src/big.ts', 5)).toEqual({
    ok: false,
    reason: 'line is outside the diff hunks of this file',
  });
  expect(check('src/a.ts', 1)).toEqual({ ok: false, reason: 'file is not changed in the diff' });
  expect(check('src/新目录/new.ts', 3).ok).toBe(true); // untracked file: all lines are new
  expect(check('src/新目录/new.ts', 9).ok).toBe(false);
  expect(check('src/gone.ts', 1).ok).toBe(true); // deleted file: old side
  expect(check('src/missing.ts', 1).reason).toContain('exists neither');
  expect(check('../outside.ts', 1).reason).toContain('not a repository-relative path');
  expect(check('/etc/passwd', 1).reason).toContain('not a repository-relative path');
  expect(() => gitLineChecker('no-such-ref', fx.worktree)).toThrow(/not a commit/);
});

it('validateOutput applies review rules only to review schemas', () => {
  expect(validateOutput(implSchema, validImpl(), { money: false })).toEqual({
    ok: true,
    errors: [],
    warnings: [],
  });
  expect(validateOutput(reviewSchema, validReview(), { money: true }).ok).toBe(true);
  expect(
    validateOutput(reviewSchema, { ...validReview(), checklist: [] }, { money: true }).ok,
  ).toBe(false);
  expect(() => validateOutput(implSchema, validImpl(), { money: true })).toThrow(/review outputs/);
});

function runCli(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(process.execPath, [join(AGENT_DIR, 'validate-output.ts'), ...args], {
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

it('CLI: exit 0 valid, 1 invalid, 2 usage or internal error', { timeout: 60_000 }, () => {
  const fx = makeFixture('validate-cli');
  fixtures.push(fx);
  const good = join(fx.root, 'good.json');
  const bad = join(fx.root, 'bad.json');
  const broken = join(fx.root, 'broken.json');
  const review = join(fx.root, 'review.json');
  writeFileSync(good, JSON.stringify(validImpl()));
  writeFileSync(bad, JSON.stringify({ ...validImpl(), extra: true }));
  writeFileSync(broken, '{"task_done": tru');
  writeFileSync(review, JSON.stringify(validReview('src/a.ts', 1)));

  expect(runCli(['--schema', IMPL_SCHEMA_FILE, '--file', good]).status).toBe(0);

  const invalid = runCli(['--schema', IMPL_SCHEMA_FILE, '--file', bad, '--json']);
  expect(invalid.status).toBe(1);
  expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false });
  expect(invalid.stderr).toContain('invalid: schema:');

  const unparsable = runCli(['--schema', IMPL_SCHEMA_FILE, '--file', broken]);
  expect(unparsable.status).toBe(1);
  expect(unparsable.stderr).toContain('output is not valid JSON');

  expect(runCli(['--schema', IMPL_SCHEMA_FILE]).status).toBe(2);
  expect(runCli(['--schema', IMPL_SCHEMA_FILE, '--file', join(fx.root, 'none.json')]).status).toBe(
    2,
  );
  expect(runCli(['--schema', join(fx.root, 'none.json'), '--file', good]).status).toBe(2);
  expect(runCli(['--schema', IMPL_SCHEMA_FILE, '--file', good, '--money']).status).toBe(2);
  expect(runCli(['--schema', IMPL_SCHEMA_FILE, '--file', good, '--diff-base', 'HEAD']).status).toBe(
    2,
  );
  expect(runCli(['--schema', IMPL_SCHEMA_FILE, '--file', good, '--bogus']).status).toBe(2);
  expect(runCli(['--schema', IMPL_SCHEMA_FILE, '--file', good, '--refs', 'BR 1']).status).toBe(2);
  // --refs: a pass whose only S0 cites a rule outside the refs is valid, with a warning.
  const scoped = join(fx.root, 'scoped.json');
  const base = validReview('src/a.ts', 1);
  writeFileSync(
    scoped,
    JSON.stringify({
      ...base,
      verdict: 'pass',
      checklist: [],
      findings: base.findings.map((f) => ({
        ...f,
        key: 'src/a.ts#split#BR-FUND-03',
        rule: 'BR-FUND-03',
      })),
    }),
  );
  const scopedArgs = ['--schema', REVIEW_SCHEMA_FILE, '--file', scoped];
  expect(runCli(scopedArgs).status).toBe(1);
  const withRefs = runCli([...scopedArgs, '--refs', 'BR-CALC-01,BR-CALC-08']);
  expect(withRefs.status).toBe(0);
  expect(withRefs.stderr).toContain('warning: findings[0]: rule cites BR-FUND-03');

  // Money review against the real diff: src/a.ts is unchanged in the fixture worktree.
  const moneyArgs = ['--schema', REVIEW_SCHEMA_FILE, '--file', review, '--money'];
  expect(runCli(moneyArgs).status).toBe(0);
  const outside = runCli([...moneyArgs, '--diff-base', fx.baseSha, '--cwd', fx.worktree]);
  expect(outside.status).toBe(1);
  expect(outside.stderr).toContain('src/a.ts:1 file is not changed in the diff');
  writeFileSync(join(fx.worktree, 'src', 'a.ts'), 'export const a = 3;\n');
  expect(runCli([...moneyArgs, '--diff-base', fx.baseSha, '--cwd', fx.worktree]).status).toBe(0);
});
