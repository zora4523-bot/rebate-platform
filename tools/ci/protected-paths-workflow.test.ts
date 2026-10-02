// Runs the inline script of .github/workflows/protected-paths.yml exactly as written (extracted
// from the YAML), with global fetch replaced by canned GitHub API responses. The workflow cannot
// run on GitHub yet (no remote), so this is the only execution its logic gets (规划/11 §4.4).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { compareEmbeddedScript } from '../guard/lib/protected-sync.ts';

const REPO = resolve(import.meta.dirname, '../..');
const SCRATCH = join(REPO, '.tmp', `ci-protected-paths-${process.pid}`);
const WORKFLOW = readFileSync(join(REPO, '.github/workflows/protected-paths.yml'), 'utf8');
const API = 'https://api.github.invalid';
const HEAD = 'a'.repeat(40);
const BASE_TIP = 'b'.repeat(40);
const MERGE_BASE = 'c'.repeat(40);
const APPROVAL_LABEL = `owner-approved-${HEAD.slice(0, 12)}`;

/** Lines from `first` to `last` (inclusive bounds chosen by the caller), de-indented. */
function sliceLines(isFirst: (l: string) => boolean, isLast: (l: string) => boolean): string[] {
  const lines = WORKFLOW.split('\n');
  const first = lines.findIndex(isFirst);
  const last = lines.findIndex((l, i) => i > first && isLast(l));
  if (first < 0 || last < 0) throw new Error('cannot find the block in protected-paths.yml');
  const block = lines.slice(first, last + 1);
  const indent = Math.min(...block.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)));
  return block.map((l) => l.slice(indent));
}

// The script between the heredoc markers, and the env value including its marker lines.
const SCRIPT = sliceLines(
  (l) => l.trimEnd().endsWith("<<'NODE'"),
  (l) => l.trim() === 'NODE',
)
  .slice(1, -1)
  .join('\n');
const PROTECTED_PATHS = sliceLines(
  (l) => l.trim() === '# BEGIN protected-paths.json',
  (l) => l.trim() === '# END protected-paths.json',
).join('\n');

type ChangedFile = { filename: string; status: string; previous_filename?: string };
type Scenario = {
  files: ChangedFile[];
  labels?: string[];
  /** Who added each label according to the issue timeline (default: the owner account `o`). */
  labeledBy?: Record<string, string>;
  headRef?: string;
  /** File contents keyed by `<ref>:<path>`. */
  contents?: Record<string, string>;
  liveHead?: string;
};

let scenarioCount = 0;

function run(scenario: Scenario): { status: number | null; hits: string[]; out: string } {
  mkdirSync(SCRATCH, { recursive: true });
  const routes: Record<string, { status: number; body: unknown }> = {
    '/repos/o/r/pulls/7': {
      status: 200,
      body: {
        head: {
          sha: scenario.liveHead ?? HEAD,
          ref: scenario.headRef ?? 'task/B1-01',
          repo: { full_name: 'o/r' },
        },
        base: { sha: BASE_TIP },
        labels: (scenario.labels ?? []).map((name) => ({ name })),
      },
    },
    [`/repos/o/r/compare/${BASE_TIP}...${scenario.liveHead ?? HEAD}`]: {
      status: 200,
      body: { merge_base_commit: { sha: MERGE_BASE } },
    },
    '/repos/o/r/issues/7/events?per_page=100&page=1': {
      status: 200,
      body: (scenario.labels ?? []).map((name) => ({
        event: 'labeled',
        label: { name },
        actor: { login: scenario.labeledBy?.[name] ?? 'o' },
      })),
    },
  };
  for (let page = 0; page * 100 <= scenario.files.length; page++) {
    routes[`/repos/o/r/pulls/7/files?per_page=100&page=${page + 1}`] = {
      status: 200,
      body: scenario.files.slice(page * 100, page * 100 + 100),
    };
  }
  for (const [key, text] of Object.entries(scenario.contents ?? {})) {
    const [ref, path] = key.split(':') as [string, string];
    routes[`/repos/o/r/contents/${path}?ref=${ref}`] = { status: 200, body: text };
  }
  const routesFile = join(SCRATCH, `routes-${++scenarioCount}.json`);
  writeFileSync(routesFile, JSON.stringify(routes));
  const result = spawnSync(
    process.execPath,
    ['--import', join(REPO, 'tools/ci/testing/fake-github.ts'), '--input-type=module'],
    {
      input: SCRIPT,
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        GITHUB_API_URL: API,
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_REPOSITORY_OWNER: 'o',
        GH_TOKEN: 'not-a-real-token',
        PR_NUMBER: '7',
        EVENT_HEAD_SHA: HEAD,
        PROTECTED_PATHS,
        COULI_FAKE_GITHUB: routesFile,
      },
    },
  );
  const out = `${result.stdout}\n${result.stderr}`;
  const hits = result.stdout
    .split('\n')
    .filter((l) => l.startsWith('- class '))
    .map((l) => l.replace(/^- class (\d): `([^`]+)`.*$/, '$1 $2'));
  return { status: result.status, hits, out };
}

const manifest = (scripts: Record<string, string>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'x', ...extra, scripts });

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

it('the extracted script and list look like what the workflow ships', () => {
  expect(SCRIPT).toContain("getJson('/repos/' + repo + '/pulls/' + prNumber)");
  expect(SCRIPT).not.toContain('${{');
  expect(PROTECTED_PATHS.split('\n')[0]).toBe('# BEGIN protected-paths.json');
}, 60_000);

it('the owner-approval check is the verbatim copy of tools/guard/lib/owner-approval.mjs', () => {
  const source = readFileSync(join(REPO, 'tools/guard/lib/owner-approval.mjs'), 'utf8');
  expect(compareEmbeddedScript(source, WORKFLOW)).toEqual([]);
  expect(SCRIPT).toContain('const approval = await checkOwnerApproval({');
}, 60_000);

it('passes when no protected path is touched', () => {
  const result = run({
    files: [
      { filename: 'apps/api/src/modules/identity/index.ts', status: 'modified' },
      { filename: 'docs/README.md', status: 'modified' },
      { filename: 'ops/tasks/B1-01.yaml', status: 'modified' },
    ],
  });
  expect([result.status, result.hits]).toEqual([0, []]);
}, 60_000);

it('class 1: additions pass, modifications, removals and renames fail', () => {
  const added = run({ files: [{ filename: 'test/spec/ledger/a.test.ts', status: 'added' }] });
  const changed = run({
    files: [
      { filename: 'test/spec/ledger/a.test.ts', status: 'modified' },
      { filename: 'packages/testing/src/index.ts', status: 'removed' },
      {
        filename: 'test/archive/b.test.ts',
        status: 'renamed',
        previous_filename: 'test/properties/b.test.ts',
      },
    ],
  });
  expect([added.status, added.hits]).toEqual([0, []]);
  expect([changed.status, changed.hits]).toEqual([
    1,
    [
      '1 test/spec/ledger/a.test.ts',
      '1 packages/testing/src/index.ts',
      '1 test/properties/b.test.ts',
    ],
  ]);
}, 60_000);

it('class 2 and 3: any change fails, including new files and root-level matches', () => {
  const result = run({
    files: [
      { filename: 'packages/money/vitest.config.ts', status: 'modified' },
      { filename: 'vitest.shared.ts', status: 'modified' },
      { filename: 'eslint.config.js', status: 'modified' },
      { filename: 'tools/guard/new-guard.ts', status: 'added' },
      { filename: 'AGENTS.md', status: 'modified' },
      { filename: 'apps/api/src/modules/ledger/CLAUDE.md', status: 'added' },
      { filename: '.github/workflows/ci.yml', status: 'modified' },
      { filename: 'ops/approvals.yaml', status: 'modified' },
    ],
  });
  expect([result.status, result.hits]).toEqual([
    1,
    [
      '2 packages/money/vitest.config.ts',
      '2 vitest.shared.ts',
      '2 eslint.config.js',
      '3 tools/guard/new-guard.ts',
      '3 AGENTS.md',
      '3 apps/api/src/modules/ledger/CLAUDE.md',
      '3 .github/workflows/ci.yml',
      '3 ops/approvals.yaml',
    ],
  ]);
}, 60_000);

it('the owner-approval label for this exact head lets a hit pass; a stale label does not', () => {
  const files = [{ filename: 'turbo.json', status: 'modified' }];
  const approved = run({ files, labels: [APPROVAL_LABEL] });
  const stale = run({ files, labels: [`owner-approved-${'d'.repeat(12)}`] });
  expect([approved.status, approved.hits]).toEqual([0, ['2 turbo.json']]);
  expect([stale.status, stale.hits]).toEqual([1, ['2 turbo.json']]);
  // The label counts only when the timeline says the owner account added it.
  const byBot = run({ files, labels: [APPROVAL_LABEL], labeledBy: { [APPROVAL_LABEL]: 'ci-bot' } });
  expect([byBot.status, byBot.hits]).toEqual([1, ['2 turbo.json']]);
  expect(byBot.out).toContain('added by `ci-bot`, not by the owner account');
}, 60_000);

it('package.json: only a change of the scripts object counts', () => {
  const file = { filename: 'packages/money/package.json', status: 'modified' };
  const depsOnly = run({
    files: [file],
    contents: {
      [`${MERGE_BASE}:packages/money/package.json`]: manifest({
        test: 'vitest run',
        build: 'tsc -b',
      }),
      [`${HEAD}:packages/money/package.json`]: manifest(
        { build: 'tsc -b', test: 'vitest run' },
        { dependencies: { zod: '4.6.5' } },
      ),
    },
  });
  const scriptsChanged = run({
    files: [file],
    contents: {
      [`${MERGE_BASE}:packages/money/package.json`]: manifest({ test: 'vitest run' }),
      [`${HEAD}:packages/money/package.json`]: manifest({ test: 'vitest run --passWithNoTests' }),
    },
  });
  const newManifest = run({
    files: [{ filename: 'packages/new/package.json', status: 'added' }],
    contents: { [`${HEAD}:packages/new/package.json`]: manifest({ test: 'true' }) },
  });
  expect([depsOnly.status, depsOnly.hits]).toEqual([0, []]);
  expect([scriptsChanged.status, scriptsChanged.hits]).toEqual([
    1,
    ['2 packages/money/package.json'],
  ]);
  expect([newManifest.status, newManifest.hits]).toEqual([1, ['2 packages/new/package.json']]);
}, 60_000);

it('pnpm-lock.yaml: allowed only on a task branch whose task file says type: deps', () => {
  const files = [{ filename: 'pnpm-lock.yaml', status: 'modified' }];
  const depsTask = run({
    files,
    headRef: 'task/DEPS-03',
    contents: { [`${HEAD}:ops/tasks/DEPS-03.yaml`]: 'id: DEPS-03\ntype: deps\nstatus: todo\n' },
  });
  const implTask = run({
    files,
    headRef: 'task/B1-01',
    contents: { [`${HEAD}:ops/tasks/B1-01.yaml`]: 'id: B1-01\ntype: impl\nstatus: todo\n' },
  });
  const noTaskBranch = run({ files, headRef: 'feature/x' });
  expect([depsTask.status, depsTask.hits]).toEqual([0, []]);
  expect([implTask.status, implTask.hits]).toEqual([1, ['2 pnpm-lock.yaml']]);
  expect([noTaskBranch.status, noTaskBranch.hits]).toEqual([1, ['2 pnpm-lock.yaml']]);
}, 60_000);

it('fails closed when the PR head moved or the API cannot be read', () => {
  const moved = run({ files: [], liveHead: 'e'.repeat(40) });
  const unreadable = run({
    files: [{ filename: 'package.json', status: 'modified' }],
    // no contents routes: the manifest cannot be read, so the scripts cannot be compared
  });
  const paged = run({
    files: Array.from({ length: 150 }, (_, i) => ({
      filename: `docs/n${i}.md`,
      status: 'added',
    })).concat([{ filename: 'tools/ops/merge.sh', status: 'modified' }]),
  });
  expect(moved.status).toBe(1);
  expect(unreadable.status).toBe(1);
  expect(unreadable.out).toContain('cannot read package.json');
  expect([paged.status, paged.hits]).toEqual([1, ['3 tools/ops/merge.sh']]);
}, 60_000);
