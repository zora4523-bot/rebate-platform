// End-to-end tests of the guard command lines against fixture trees and repositories.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../lib/paths.ts';
import { renderRiskTable, TABLE_BEGIN, TABLE_END } from './lib/agents-table.ts';
import { cleanupFixtures, fixtureGit, makeRepo, makeTree, writeFiles } from './lib/fixture-kit.ts';
import { loadRiskMap } from './lib/risk.ts';
import * as fx from './lib/test-guard.fixtures.ts';

const GUARD_DIR = join(repoRoot(), 'tools', 'guard');
let trusted = '';

const LEDGER_TASK = [
  'id: B2-02a',
  'repo: rebate-platform',
  'title: ledger：凭证与分录写入',
  'type: impl',
  'refs: [BR-FUND-13]',
  'refs_hash:',
  '  BR-FUND-13: 0123456789ab',
  'deps: []',
  'paths:',
  '  - "apps/api/src/modules/ledger/**"',
  'impl: codex',
  'tester: claude',
  'accept:',
  '  - "pnpm verify"',
  'status: todo',
  'pr: null',
  '',
].join('\n');

const DEPS_TASK = LEDGER_TASK.replace('id: B2-02a', 'id: D1-01')
  .replace('type: impl', 'type: deps')
  .replace('  - "apps/api/src/modules/ledger/**"', '  - "package.json"\n  - "pnpm-lock.yaml"');

/** A task of the default split of 2026-10-05: Codex writes its rule tests into test_paths. */
const AUTHOR_TASK = LEDGER_TASK.replace('id: B2-02a', 'id: B2-02b')
  .replace('impl: codex', 'impl: claude')
  .replace('tester: claude', 'tester: codex\ntest_paths:\n  - "test/spec/ledger/**"');
const OLD_LEDGER_TASK = AUTHOR_TASK.replace('id: B2-02b', 'id: B2-02c').replace(
  'test_paths:\n  - "test/spec/ledger/**"\n',
  '',
);
/** A new task (not a ledger of the switch baseline) that omits test_paths (CR2-02). */
const NEW_NO_TEST_PATHS_TASK = OLD_LEDGER_TASK.replace('id: B2-02c', 'id: B2-02d');
const NO_TESTER_TASK = LEDGER_TASK.replace('id: B2-02a', 'id: N1-01').replace(
  'tester: claude',
  'tester: none',
);

const APPROVALS = [
  'source: "规划/11 §7.3"',
  'spec_ref: cbd8f06fa7ab14631f1e7f4dd9106fda8bef749b',
  'approvals:',
  '  - id: 0',
  '    row: 0',
  '    title: "技术栈锁定"',
  '    granted: true',
  '    date: "2026-10-01"',
  '    note: ""',
  '  - id: 1',
  '    row: 1',
  '    title: "建仓库"',
  '    granted: false',
  '    date: "2026-10-01"',
  '    note: ""',
  '',
].join('\n');

function guard(
  name: string,
  args: string[],
  opts: { cwd?: string; input?: string; env?: Record<string, string> } = {},
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [join(GUARD_DIR, name), ...args], {
    cwd: opts.cwd ?? trusted,
    input: opts.input ?? '',
    encoding: 'utf8',
    env: {
      ...process.env,
      COULI_TRUSTED_ROOT: trusted,
      COULI_SPEC_REPO: '/nonexistent/planning-repo',
      ...opts.env,
    },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function json<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

function workRepo(): { root: string; base: string } {
  return makeRepo({
    'apps/api/src/modules/ledger/post.ts': 'export const post = 1;\n',
    'apps/api/src/modules/orders/sync.ts': 'export const sync = 1;\n',
    'test/spec/ledger/post.test.ts': "it('posts', () => {});\n",
    'package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }, null, 2),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'turbo.json': '{}\n',
    'docs/notes.md': '# notes\n',
  });
}

beforeAll(() => {
  trusted = makeTree({
    'ops/tasks/B2-02a.yaml': LEDGER_TASK,
    'ops/tasks/D1-01.yaml': DEPS_TASK,
    'ops/tasks/B2-02b.yaml': AUTHOR_TASK,
    'ops/tasks/B2-02c.yaml': OLD_LEDGER_TASK,
    'ops/tasks/N1-01.yaml': NO_TESTER_TASK,
    'ops/tasks/B2-02d.yaml': NEW_NO_TEST_PATHS_TASK,
    // The fixture's own switch-baseline list: B2-02a stands for a ledger written before
    // 2026-10-05 (no test_paths, old scope); B2-02d is not on it.
    'tools/guard/legacy-tasks.json': JSON.stringify({ baseline: 'fixture', tasks: ['B2-02a'] }),
    'ops/approvals.yaml': APPROVALS,
  });
  for (const file of [
    'tools/guard/protected-paths.json',
    'tools/guard/banned-terms.txt',
    'tools/guard/banned-terms.allow.txt',
    'ops/risk-map.yaml',
  ]) {
    mkdirSync(dirname(join(trusted, file)), { recursive: true });
    copyFileSync(join(repoRoot(), file), join(trusted, file));
  }
});

afterAll(cleanupFixtures);

describe('risk-of-paths.ts', () => {
  it('prints the report as JSON and always exits 0', () => {
    const res = guard('risk-of-paths.ts', [
      '--json',
      'packages/money/src/index.ts',
      'docs/README.md',
      'turbo.json',
    ]);
    expect(res.status).toBe(0);
    expect(json(res.stdout)).toEqual({
      risk: 'RV2',
      ask: true,
      paths: [
        {
          path: 'packages/money/src/index.ts',
          risk: 'RV2',
          rule: 'packages/money/**',
          protected: null,
        },
        { path: 'docs/README.md', risk: 'RV0', rule: 'docs/**', protected: null },
        { path: 'turbo.json', risk: 'RV2', rule: 'default', protected: 2 },
      ],
    });
  });

  it('reads newline- or NUL-separated paths from stdin', () => {
    const lines = guard('risk-of-paths.ts', ['--json', '--stdin'], {
      input: 'docs/a.md\ndocs/中 文.md\n',
    });
    expect(json<{ risk: string; paths: unknown[] }>(lines.stdout)).toMatchObject({ risk: 'RV0' });
    const nul = guard('risk-of-paths.ts', ['--json', '--stdin'], {
      input: 'docs/a.md\0contracts/openapi.yaml\0',
    });
    expect(json<{ risk: string; paths: unknown[] }>(nul.stdout).risk).toBe('RV1');
    expect(json<{ paths: unknown[] }>(nul.stdout).paths).toHaveLength(2);
  });

  it('prints a readable table without --json and rejects wrong usage with exit 2', () => {
    const res = guard('risk-of-paths.ts', ['docs/a.md']);
    expect(res.stdout).toBe('RV0  docs/a.md  (docs/**)\nrisk: RV0\n');
    expect(guard('risk-of-paths.ts', []).status).toBe(2);
    expect(guard('risk-of-paths.ts', ['--stdin', 'x']).status).toBe(2);
    expect(guard('risk-of-paths.ts', ['--nope']).status).toBe(2);
  });
});

describe('path-guard.ts, protected-paths.ts, test-guard.ts, run.ts git', () => {
  type PathGuardJson = {
    ok: boolean;
    violations: { path: string; reason: string }[];
    out_of_scope_ops_docs: string[];
    protected_hits: { path: string; class: number }[];
  };

  it('passes a change that stays inside the task paths', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'apps/api/src/modules/ledger/post.ts': 'export const post = 2;\n',
      'apps/api/src/modules/ledger/新 文件.ts': 'export {};\n',
    });
    const res = guard('path-guard.ts', [
      '--task',
      'B2-02a',
      '--base',
      base,
      '--cwd',
      root,
      '--json',
    ]);
    expect(res.status).toBe(0);
    expect(json<PathGuardJson>(res.stdout)).toEqual({
      ok: true,
      violations: [],
      out_of_scope_ops_docs: [],
      protected_hits: [],
    });
    expect(guard('run.ts', ['git', '--base', base, '--task', 'B2-02a', '--cwd', root]).status).toBe(
      0,
    );
  });

  it('fails on out-of-scope changes and reports ops/docs and protected hits separately', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'apps/api/src/modules/ledger/post.ts': 'export const post = 2;\n',
      'apps/api/src/modules/orders/sync.ts': 'export const sync = 2;\n',
      'docs/notes.md': '# changed\n',
      'turbo.json': '{ "tasks": {} }\n',
      'scratch file.txt': 'x\n',
    });
    const res = guard('path-guard.ts', [
      '--task',
      'B2-02a',
      '--base',
      base,
      '--cwd',
      root,
      '--json',
    ]);
    expect(res.status).toBe(1);
    expect(json<PathGuardJson>(res.stdout)).toEqual({
      ok: false,
      violations: [
        { path: 'apps/api/src/modules/orders/sync.ts', reason: 'modified outside the task paths' },
        { path: 'scratch file.txt', reason: 'untracked file outside the task paths' },
        { path: 'turbo.json', reason: 'modified outside the task paths' },
      ],
      out_of_scope_ops_docs: ['docs/notes.md'],
      protected_hits: [{ path: 'turbo.json', class: 2 }],
    });
    expect(res.stderr).toContain('turbo.json: modified outside the task paths');
  });

  it('accepts --paths with brace groups and uses the current directory by default', () => {
    const { root, base } = workRepo();
    writeFiles(root, { 'test/spec/ledger/new.test.ts': "it('new', () => {});\n" });
    const args = ['--paths', 'docs/**,test/{spec,acceptance}/**', '--base', base];
    expect(guard('path-guard.ts', args, { cwd: join(root, 'docs') }).status).toBe(0);
    expect(
      guard('path-guard.ts', ['--paths', 'docs/**', '--base', base], { cwd: root }).status,
    ).toBe(1);
  });

  it('[CR-05, CR-06] --author: only the task test_paths and per-function NotImplemented shells', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'test/spec/ledger/new.test.ts': "it('new', () => {});\n",
      // Another area's rule tests are not this task's test_paths.
      'test/spec/money/other.test.ts': "it('other', () => {});\n",
      // A shell next to a real implementation in one file, the keyword only in a comment.
      'apps/api/src/modules/ledger/post.ts': [
        'export const post = 1;',
        "export function plan(a: number): never {\n  void a;\n  throw new Error('NotImplemented: plan');\n}",
        '// NotImplemented',
        'export function book(a: number): number {\n  return a + 1;\n}',
        '',
      ].join('\n'),
      'docs/notes.md': '# changed\n',
    });
    const res = guard('path-guard.ts', [
      '--task',
      'B2-02b',
      '--base',
      base,
      '--cwd',
      root,
      '--json',
      '--author',
    ]);
    expect(res.status).toBe(1);
    const out = json<PathGuardJson>(res.stdout);
    expect(out.violations.map((v) => v.path)).toEqual([
      'apps/api/src/modules/ledger/post.ts',
      'test/spec/money/other.test.ts',
    ]);
    expect(out.violations[0]?.reason).toContain('book: does not end with throw new NotImplemented');
    expect(out.out_of_scope_ops_docs).toEqual(['docs/notes.md']);

    // Without test_paths in the ledger the test phase is refused outright.
    const old = guard('path-guard.ts', [
      '--task',
      'B2-02c',
      '--base',
      base,
      '--cwd',
      root,
      '--json',
      '--author',
    ]);
    expect(old.status).toBe(1);
    expect(json<PathGuardJson>(old.stdout).violations[0]?.reason).toContain(
      'the task has no test_paths',
    );
  });

  it('[CR-16] red-check --json prints exactly one JSON document, also when it skips', () => {
    const { root, base } = workRepo();
    const skip = guard('red-check.ts', ['--task', 'N1-01', '--report', '/nonexistent', '--json']);
    expect(skip.status).toBe(0);
    expect(json<{ required: boolean }>(skip.stdout)).toMatchObject({ required: false, ok: true });
    expect(skip.stderr).toContain('SKIP red-check');

    writeFiles(root, { 'test/spec/ledger/new.test.ts': "it('new', () => {});\n" });
    const reportFile = join(root, '..', 'red-report.json');
    writeFileSync(
      reportFile,
      JSON.stringify({
        testResults: [
          {
            name: `${root}/test/spec/ledger/new.test.ts`,
            assertionResults: [
              { fullName: 'new', status: 'failed', failureMessages: ['Error: NotImplemented'] },
            ],
          },
        ],
      }),
    );
    const res = guard('red-check.ts', [
      '--task',
      'B2-02b',
      '--report',
      reportFile,
      '--cwd',
      root,
      '--base',
      base,
      '--root',
      root,
      '--json',
    ]);
    expect(res.status, res.stderr).toBe(0);
    expect(json<{ ok: boolean; expected: string[] }>(res.stdout)).toMatchObject({
      ok: true,
      expected: ['test/spec/ledger/new.test.ts'],
    });
    expect(res.stderr).toContain('PASS red-check');
  });

  it('rejects wrong usage with exit 2', () => {
    const { root, base } = workRepo();
    expect(guard('path-guard.ts', ['--task', 'B2-02a', '--cwd', root]).status).toBe(2);
    expect(guard('path-guard.ts', ['--base', base, '--cwd', root]).status).toBe(2);
    expect(
      guard('path-guard.ts', ['--task', 'B2-02a', '--paths', 'a/**', '--base', base]).status,
    ).toBe(2);
    expect(guard('path-guard.ts', ['--task', 'B9-99', '--base', base, '--cwd', root]).status).toBe(
      2,
    );
    expect(
      guard('path-guard.ts', ['--task', 'B2-02a', '--base', 'no-such-ref', '--cwd', root]).status,
    ).toBe(2);
  });

  it('reads the task from the trusted root, not from the worktree', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'ops/tasks/B2-02a.yaml': LEDGER_TASK.replace('apps/api/src/modules/ledger/**', '**'),
      'apps/api/src/modules/orders/sync.ts': 'export const sync = 3;\n',
    });
    const res = guard('path-guard.ts', [
      '--task',
      'B2-02a',
      '--base',
      base,
      '--cwd',
      root,
      '--json',
    ]);
    expect(res.status).toBe(1);
    expect(json<PathGuardJson>(res.stdout).out_of_scope_ops_docs).toEqual([
      'ops/tasks/B2-02a.yaml',
    ]);
  });

  it('lists protected hits by class and exits 1', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'test/spec/ledger/post.test.ts': "it('posts differently', () => {});\n",
      'test/spec/ledger/added.test.ts': "it('added', () => {});\n",
      'package.json': JSON.stringify({ name: 'x', scripts: { test: 'true' } }, null, 2),
      'pnpm-lock.yaml': 'lockfileVersion: 9\npackages: {}\n',
      'packages/money/AGENTS.md': '# rules\n',
    });
    const res = guard('protected-paths.ts', ['--base', base, '--cwd', root, '--json']);
    expect(res.status).toBe(1);
    expect(
      json<{ ok: boolean; class1: string[]; class2: string[]; class3: string[] }>(res.stdout),
    ).toMatchObject({
      ok: false,
      class1: ['test/spec/ledger/post.test.ts'],
      class2: ['package.json', 'pnpm-lock.yaml'],
      class3: ['packages/money/AGENTS.md'],
    });
  });

  it('allows the lock file and dependency edits in a deps task', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'package.json': JSON.stringify(
        { name: 'x', scripts: { test: 'vitest run' }, dependencies: { zod: '4.6.5' } },
        null,
        2,
      ),
      'pnpm-lock.yaml': 'lockfileVersion: 9\npackages: {}\n',
    });
    expect(guard('protected-paths.ts', ['--base', base, '--cwd', root]).status).toBe(1);
    const deps = guard('protected-paths.ts', [
      '--base',
      base,
      '--cwd',
      root,
      '--task-type',
      'deps',
    ]);
    expect(deps.status).toBe(0);
    expect(deps.stdout).toBe('PASS protected-paths\n');
    expect(guard('run.ts', ['git', '--base', base, '--task', 'D1-01', '--cwd', root]).status).toBe(
      0,
    );
    expect(guard('protected-paths.ts', ['--base', base, '--task-type', 'nope']).status).toBe(2);
    expect(guard('protected-paths.ts', ['--cwd', root]).status).toBe(2);
  });

  it('test-guard reports static findings and modified test assets', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'test/spec/ledger/post.test.ts': "describe('ledger', () => {});\n",
      'apps/api/src/modules/ledger/post.test.ts': fx.LISTEN,
    });
    const res = guard('test-guard.ts', ['--base', base, '--cwd', root, '--json']);
    expect(res.status).toBe(1);
    const out = json<{
      ok: boolean;
      findings: { file: string; rule: string }[];
      add_only_violations: { path: string }[];
    }>(res.stdout);
    expect(out.ok).toBe(false);
    expect(out.findings.map((f) => `${f.file}:${f.rule}`)).toEqual([
      'apps/api/src/modules/ledger/post.test.ts:unit-no-listen',
      'test/spec/ledger/post.test.ts:rule-tests-top-level-it',
    ]);
    expect(out.add_only_violations.map((v) => v.path)).toEqual(['test/spec/ledger/post.test.ts']);
    expect(guard('test-guard.ts', ['--cwd', root]).status).toBe(1);
  });

  it('run.ts git prints one line per check and fails when any check fails', () => {
    const { root, base } = workRepo();
    writeFiles(root, { 'turbo.json': '{ "x": 1 }\n' });
    const withTask = guard('run.ts', ['git', '--base', base, '--task', 'B2-02a', '--cwd', root]);
    expect(withTask.status).toBe(1);
    expect(withTask.stdout).toBe(
      [
        'FAIL path-guard (1 problem)',
        'FAIL protected-paths (1 problem)',
        'PASS test-guard',
        'guard git: 1 passed, 2 failed, 0 skipped',
        '',
      ].join('\n'),
    );
    const withoutTask = guard('run.ts', ['git', '--base', base, '--cwd', root]);
    expect(withoutTask.stdout.split('\n')[0]).toBe('FAIL protected-paths (1 problem)');
    expect(guard('run.ts', ['git', '--cwd', root]).status).toBe(2);
    expect(guard('run.ts', ['git', '--base', base, '--cwd', makeTree()]).status).toBe(2);
    expect(guard('run.ts', ['bogus']).status).toBe(2);
  });
});

describe('run.ts static and the single-purpose guards', () => {
  function staticTree(extra: Record<string, string> = {}): string {
    const table = renderRiskTable(loadRiskMap(repoRoot()));
    const root = makeTree({
      'AGENTS.md': `# AGENTS\n\n${TABLE_BEGIN}\n${table}\n${TABLE_END}\n`,
      'CLAUDE.md': '@AGENTS.md\n',
      SPEC_REF: 'cbd8f06fa7ab14631f1e7f4dd9106fda8bef749b\n',
      'ops/risk-map.yaml': readFileSync(join(repoRoot(), 'ops', 'risk-map.yaml'), 'utf8'),
      'tools/guard/protected-paths.json': readFileSync(
        join(GUARD_DIR, 'protected-paths.json'),
        'utf8',
      ),
      'packages/money/src/index.test.ts': "it('works', () => {});\n",
      ...extra,
    });
    return root;
  }

  it('passes on a consistent tree without .git, skipping what needs the planning repository', () => {
    const res = guard('run.ts', ['static', '--cwd', staticTree()]);
    expect(res.stdout.split('\n')).toEqual([
      `SKIP schema-lint (tools/agent/schemas does not exist yet)`,
      'PASS agents-pair',
      'PASS risk-map-coverage',
      'PASS agents-table',
      'SKIP protected-sync (.github/workflows/protected-paths.yml does not exist yet)',
      'PASS test-guard',
      'PASS hidden-unicode',
      expect.stringMatching(/^(PASS|SKIP) lockfile-urls/),
      expect.stringMatching(/^SKIP spec-ref \(planning repository not found/),
      expect.stringMatching(/^SKIP banned-terms \(planning repository not found/),
      'guard static: 6 passed, 0 failed, 4 skipped',
      '',
    ]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('no .git directory');
  });

  it('needs no git binary on a tree without .git (verify image)', () => {
    const root = staticTree();
    const res = guard('run.ts', ['static'], { cwd: root, env: { PATH: makeTree() } });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('guard static: 6 passed, 0 failed, 4 skipped');
  });

  it('accepts the argument separator that pnpm forwards', () => {
    const res = guard('run.ts', ['static', '--', '--cwd', staticTree()]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('PASS agents-pair');
  });

  it('fails with one line per failed check', () => {
    const zeroWidth = String.fromCodePoint(0x200b);
    const root = staticTree({
      'packages/extra/src/index.ts': `export const x = 1;${zeroWidth}\n`,
      'apps/api/AGENTS.md': '# nested rules\n',
      'tools/agent/schemas/impl.schema.json': JSON.stringify({ type: 'object', properties: {} }),
      '.github/workflows/protected-paths.yml':
        '# BEGIN protected-paths.json\n# { "class1_add_only": [] }\n# END protected-paths.json\n',
      'packages/money/src/index.test.ts': fx.RETRY_OPTION,
    });
    const res = guard('run.ts', ['static', '--cwd', root]);
    expect(res.status).toBe(1);
    expect(res.stdout.split('\n').slice(0, 7)).toEqual([
      'FAIL schema-lint (2 problems)',
      'FAIL agents-pair (1 problem)',
      'FAIL risk-map-coverage (1 problem)',
      'PASS agents-table',
      'FAIL protected-sync (2 problems)',
      'FAIL test-guard (1 problem)',
      'FAIL hidden-unicode (1 problem)',
    ]);
    expect(res.stderr).toContain('packages/extra/src/index.ts:1:20: U+200B ZERO WIDTH SPACE');
    expect(res.stderr).toContain('apps/api/AGENTS.md: no sibling CLAUDE.md');
  });

  it('requires the planning repository in a git checkout unless told otherwise', () => {
    const { root } = makeRepo({ SPEC_REF: 'cbd8f06fa7ab14631f1e7f4dd9106fda8bef749b\n' });
    expect(guard('spec-ref.ts', ['--cwd', root]).status).toBe(1);
    expect(guard('spec-ref.ts', ['--cwd', root, '--allow-missing-spec']).stdout).toMatch(
      /^SKIP spec-ref/,
    );
    expect(guard('banned-terms.ts', ['--spec', '--cwd', root]).status).toBe(1);
    expect(guard('banned-terms.ts', ['--spec', '--cwd', root, '--allow-missing-spec']).status).toBe(
      0,
    );
  });

  it('spec-ref and banned-terms --spec read the planning repository at SPEC_REF only', () => {
    const spec = makeRepo({
      '规划/02_系统架构.md': '数据访问 | 不要引入 Prisma 或第二种数据访问方式\n队列用 BullMQ\n',
      '规划/08_业务规则/README.md': '没有问题\n',
      'README.md': '参考文档里可以提 Prisma\n',
    });
    fixtureGit(spec.root, ['update-ref', 'refs/remotes/origin/main', spec.base]);
    // The working tree of the planning repository is never read.
    writeFiles(spec.root, { '规划/02_系统架构.md': '已清理\n' });
    const root = makeTree({ SPEC_REF: `${spec.base}\n` });
    const env = { COULI_SPEC_REPO: spec.root };
    expect(guard('spec-ref.ts', ['--cwd', root], { env }).stdout).toBe('PASS spec-ref\n');
    const res = guard('banned-terms.ts', ['--spec', '--cwd', root], { env });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('规划/02_系统架构.md:2: banned term "BullMQ"');
    expect(res.stderr).not.toContain('Prisma');
    expect(res.stdout).toBe('FAIL banned-terms (1 problem)\n');
  });

  it('banned-terms --file scans task briefs', () => {
    const dir = makeTree({
      'brief.md': '# 任务\n事件写 outbox 表\n',
      'clean.md': '# 任务\n同一事务入队\n',
    });
    expect(guard('banned-terms.ts', ['--file', join(dir, 'clean.md')]).status).toBe(0);
    const bad = guard('banned-terms.ts', ['--file', join(dir, 'clean.md'), join(dir, 'brief.md')]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('brief.md:2: banned term "outbox"');
    expect(guard('banned-terms.ts', ['--file', join(dir, 'missing.md')]).status).toBe(1);
    expect(guard('banned-terms.ts', []).status).toBe(2);
    expect(guard('banned-terms.ts', ['--spec', '--file', 'x']).status).toBe(2);
  });

  it('approvals --require answers from ops/approvals.yaml of the trusted root', () => {
    expect(guard('approvals.ts', ['--require', '0']).status).toBe(0);
    expect(guard('approvals.ts', ['--require', '1']).status).toBe(1);
    expect(guard('approvals.ts', ['--require', '7']).status).toBe(1);
    expect(json(guard('approvals.ts', ['--require', '0', '--json']).stdout)).toMatchObject({
      id: 0,
      granted: true,
    });
    expect(guard('approvals.ts', ['--require', 'yes']).status).toBe(2);
    expect(guard('approvals.ts', []).status).toBe(2);
    const empty = makeTree();
    expect(
      guard('approvals.ts', ['--require', '0'], { env: { COULI_TRUSTED_ROOT: empty } }).status,
    ).toBe(1);
    const broken = makeTree({ 'ops/approvals.yaml': 'approvals: yes\n' });
    expect(
      guard('approvals.ts', ['--require', '0'], { env: { COULI_TRUSTED_ROOT: broken } }).status,
    ).toBe(2);
  });

  it('schema-lint checks explicit files and the schema directory', () => {
    const good = {
      type: 'object',
      additionalProperties: false,
      required: ['a'],
      properties: { a: { type: 'string' } },
    };
    const root = makeTree({
      'tools/agent/schemas/good.schema.json': JSON.stringify(good),
      'bad.json': JSON.stringify({ ...good, required: [] }),
    });
    expect(guard('schema-lint.ts', ['--cwd', root]).stdout).toBe('PASS schema-lint\n');
    const bad = guard('schema-lint.ts', [join(root, 'bad.json')]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('property "a" is missing from "required"');
    const none = guard('schema-lint.ts', ['--cwd', makeTree()]);
    expect(none.status).toBe(0);
    expect(none.stderr).toContain('does not exist yet');
  });

  it('agents-table --write fills the markers and --check verifies them', () => {
    const root = makeTree({
      'AGENTS.md': `# AGENTS\n\n${TABLE_BEGIN}\n${TABLE_END}\n\n## next\n`,
      'ops/risk-map.yaml': readFileSync(join(repoRoot(), 'ops', 'risk-map.yaml'), 'utf8'),
    });
    expect(guard('agents-table.ts', ['--check', '--cwd', root]).status).toBe(1);
    expect(guard('agents-table.ts', ['--write', '--cwd', root]).status).toBe(0);
    expect(guard('agents-table.ts', ['--check', '--cwd', root]).status).toBe(0);
    const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(text).toContain('| `packages/money/**` | Claude | Codex | Claude + Codex | RV2 |');
    expect(text.endsWith(`${TABLE_END}\n\n## next\n`)).toBe(true);
    expect(guard('agents-table.ts', ['--cwd', root]).status).toBe(2);
    rmSync(join(root, 'AGENTS.md'));
    writeFileSync(join(root, 'AGENTS.md'), '# no markers\n');
    expect(guard('agents-table.ts', ['--write', '--cwd', root]).status).toBe(2);
    expect(guard('agents-table.ts', ['--check', '--cwd', root]).status).toBe(1);
  });

  it('the remaining single-purpose guards report through their own exit code', () => {
    const root = staticTree({ 'apps/api/src/modules/ledger/index.ts': 'export {};\n' });
    expect(guard('agents-pair.ts', ['--cwd', root]).stdout).toBe('PASS agents-pair\n');
    expect(guard('risk-map-coverage.ts', ['--cwd', root]).status).toBe(1);
    expect(guard('protected-sync.ts', ['--cwd', root]).status).toBe(0);
    expect(guard('hidden-unicode.ts', ['--cwd', root]).stdout).toBe('PASS hidden-unicode\n');
    expect(guard('hidden-unicode.ts', ['--cwd', root, 'extra']).status).toBe(2);
  });
});

describe('run.ts git --pr-number: owner approval (规划/11 §4.4, owner decision 2026-10-02)', () => {
  const FAKE_GITHUB = join(repoRoot(), 'tools', 'ci', 'testing', 'fake-github.ts');
  let routeCount = 0;

  /** A committed head that changes a class 2 file and modifies an add-only test asset. */
  function approvedChange(extra: Record<string, string> = {}): {
    root: string;
    base: string;
    head: string;
  } {
    const { root, base } = workRepo();
    writeFiles(root, {
      'turbo.json': '{ "x": 1 }\n',
      'test/spec/ledger/post.test.ts': "it('posts, rewritten', () => {});\n",
      ...extra,
    });
    fixtureGit(root, ['add', '-A']);
    fixtureGit(root, ['commit', '-q', '-m', 'test-change']);
    return { root, base, head: fixtureGit(root, ['rev-parse', 'HEAD']) };
  }

  /** run.ts git with fetch answered from canned routes for PR #7 of o/r (owner account `o`). */
  function guardWithPr(
    root: string,
    args: string[],
    pr: { head: string; labels: string[]; labeledBy?: string },
  ): { status: number | null; stdout: string; stderr: string } {
    const routes = {
      '/repos/o/r/pulls/7': {
        status: 200,
        body: { head: { sha: pr.head }, labels: pr.labels.map((name) => ({ name })) },
      },
      '/repos/o/r/issues/7/events?per_page=100&page=1': {
        status: 200,
        body: pr.labels.map((name) => ({
          event: 'labeled',
          label: { name },
          actor: { login: pr.labeledBy ?? 'o' },
        })),
      },
    };
    const file = join(root, '..', `routes-${process.pid}-${++routeCount}.json`);
    writeFileSync(file, JSON.stringify(routes));
    const res = spawnSync(
      process.execPath,
      ['--import', FAKE_GITHUB, join(GUARD_DIR, 'run.ts'), 'git', ...args, '--cwd', root],
      {
        cwd: trusted,
        encoding: 'utf8',
        env: {
          ...process.env,
          COULI_TRUSTED_ROOT: trusted,
          COULI_SPEC_REPO: '/nonexistent/planning-repo',
          COULI_FAKE_GITHUB: file,
          GITHUB_API_URL: 'https://api.github.invalid',
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_REPOSITORY_OWNER: 'o',
          GH_TOKEN: 'not-a-real-token',
        },
      },
    );
    rmSync(file, { force: true });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  const label = (sha: string): string => `owner-approved-${sha.slice(0, 12)}`;

  it('a valid label turns protected-path and add-only problems into warnings', () => {
    const { root, base, head } = approvedChange();
    const without = guard('run.ts', ['git', '--base', base, '--cwd', root]);
    expect(without.status).toBe(1);
    const res = guardWithPr(root, ['--base', base, '--pr-number', '7'], {
      head,
      labels: [label(head)],
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(
      [
        'PASS protected-paths (2 warnings, owner-approved)',
        'PASS test-guard (1 warning, owner-approved)',
        'guard git: 2 passed, 0 failed, 0 skipped',
        '',
      ].join('\n'),
    );
    // Still printed, as warnings.
    expect(res.stderr).toContain('protected-paths: warning: turbo.json: class 2');
    expect(res.stderr).toContain(
      'protected-paths: warning: test/spec/ledger/post.test.ts: class 1',
    );
    expect(res.stderr).toContain(
      'test-guard: warning: test/spec/ledger/post.test.ts: [add-only] existing test asset',
    );
    expect(res.stderr).toContain(`label \`${label(head)}\` added by the owner account o`);
  });

  it('a label for an older head or added by another account changes nothing', () => {
    const { root, base, head } = approvedChange();
    const stale = guardWithPr(root, ['--base', base, '--pr-number', '7'], {
      head,
      labels: [label(base)],
    });
    expect(stale.status).toBe(1);
    expect(stale.stdout.split('\n').slice(0, 2)).toEqual([
      'FAIL protected-paths (2 problems)',
      'FAIL test-guard (1 problem)',
    ]);
    expect(stale.stderr).toContain(`does not carry the label \`${label(head)}\``);

    const byBot = guardWithPr(root, ['--base', base, '--pr-number', '7'], {
      head,
      labels: [label(head)],
      labeledBy: 'ci-bot',
    });
    expect(byBot.status).toBe(1);
    expect(byBot.stderr).toContain('was added by `ci-bot`, not by the owner account');

    // The PR moved on: the label for the new head does not approve the checked commit.
    const moved = guardWithPr(root, ['--base', base, '--pr-number', '7'], {
      head: 'e'.repeat(40),
      labels: [label('e'.repeat(40))],
    });
    expect(moved.status).toBe(1);
    expect(moved.stderr).toContain(`not the checked head ${head}`);
  });

  it('every other guard problem still fails with a valid label', () => {
    const { root, base, head } = approvedChange({
      'apps/api/src/modules/ledger/post.test.ts': fx.FOCUSED_TEST,
      'apps/api/src/modules/orders/sync.ts': 'export const sync = 2;\n',
    });
    const res = guardWithPr(root, ['--base', base, '--task', 'B2-02a', '--pr-number', '7'], {
      head,
      labels: [label(head)],
    });
    expect(res.status).toBe(1);
    expect(res.stdout.split('\n').slice(0, 4)).toEqual([
      'FAIL path-guard (3 problems)',
      'PASS protected-paths (2 warnings, owner-approved)',
      'FAIL test-guard (1 problem)',
      'guard git: 1 passed, 2 failed, 0 skipped',
    ]);
    expect(res.stderr).toContain('test-guard: warning: test/spec/ledger/post.test.ts: [add-only]');
    expect(res.stderr).toContain('apps/api/src/modules/ledger/post.test.ts:1: [no-skip-only]');
  });

  it('an approval binds to a clean commit only, and the PR number is validated', () => {
    const { root, base, head } = approvedChange();
    writeFiles(root, { 'docs/notes.md': '# uncommitted\n' });
    const dirty = guardWithPr(root, ['--base', base, '--pr-number', '7'], {
      head,
      labels: [label(head)],
    });
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain('uncommitted changes');
    expect(guard('run.ts', ['git', '--base', base, '--cwd', root, '--pr-number', 'x']).status).toBe(
      2,
    );
  });
});

describe('run.ts git --task: the path guard starts at spec_commit (owner decision 2026-10-02)', () => {
  const SKELETON =
    "export function post(): number {\n  throw new Error('NotImplemented: post');\n}\n";

  function commitAll(root: string, message: string): string {
    fixtureGit(root, ['add', '-A']);
    fixtureGit(root, ['commit', '-q', '-m', message]);
    return fixtureGit(root, ['rev-parse', 'HEAD']);
  }

  /**
   * A task branch of B2-02a (paths apps/api/src/modules/ledger/**): rule-test commit(s), then
   * the implementation, then the evidence file naming `spec_commit` (default: the rule-test
   * commit). `author` overrides the rule-test author's files.
   */
  function taskBranch(
    opts: {
      author?: Record<string, string>;
      authorRemove?: string[];
      implementer?: Record<string, string>;
      evidence?: (spec: string) => unknown;
    } = {},
  ): { root: string; base: string; spec: string; head: string } {
    const { root, base } = workRepo();
    writeFiles(
      root,
      opts.author ?? {
        'test/spec/ledger/rule.test.ts': "it('[BR-FUND-13] rule', () => { expect(1).toBe(1); });\n",
        'test/properties/ledger/rule.prop.test.ts': "it('[BR-FUND-13] prop', () => {});\n",
        'apps/api/src/modules/ledger/post.ts': SKELETON,
        'ops/tasks/B2-02a.yaml': LEDGER_TASK.replace('status: todo', 'status: doing'),
      },
    );
    for (const path of opts.authorRemove ?? []) fixtureGit(root, ['rm', '-q', path]);
    const spec = commitAll(root, 'test(spec): rule tests and skeleton');
    writeFiles(
      root,
      opts.implementer ?? {
        'apps/api/src/modules/ledger/post.ts': 'export function post(): number {\n  return 2;\n}\n',
        'apps/api/src/modules/ledger/post.test.ts': "it('unit', () => { expect(2).toBe(2); });\n",
      },
    );
    const implemented = commitAll(root, 'feat(ledger): implement');
    const evidence = opts.evidence ? opts.evidence(spec) : { task: 'B2-02a', spec_commit: spec };
    if (evidence === undefined) return { root, base, spec, head: implemented };
    writeFiles(root, { 'ops/evidence/B2-02a.json': `${JSON.stringify(evidence, null, 2)}\n` });
    const head = commitAll(root, 'ops(evidence)');
    return { root, base, spec, head };
  }

  const runGit = (root: string, base: string) =>
    guard('run.ts', ['git', '--base', base, '--task', 'B2-02a', '--cwd', root]);

  it('a valid spec_commit: rule tests before it are the author’s, the rest the implementer’s', () => {
    const { root, base, spec } = taskBranch();
    const res = runGit(root, base);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe(
      [
        'PASS path-guard',
        'PASS path-guard-author',
        'PASS protected-paths',
        'PASS test-guard',
        'guard git: 4 passed, 0 failed, 0 skipped',
        '',
      ].join('\n'),
    );
    expect(res.stderr).toContain(
      `path-guard: notice: implementer scope starts at spec_commit ${spec.slice(0, 12)}`,
    );
    // The evidence file itself is an ops/ change of the implementer range: reported, not failing.
    expect(res.stderr).toContain('ops/evidence/B2-02a.json: out-of-scope change under ops/');
  });

  it('an abbreviated spec_commit is accepted once it resolves on the branch', () => {
    const { root, base } = taskBranch({
      evidence: (spec) => ({ task: 'B2-02a', spec_commit: spec.slice(0, 7) }),
    });
    expect(runGit(root, base).status).toBe(0);
  });

  it('missing evidence file: one range from the base, as before (rule tests fail)', () => {
    const { root, base } = taskBranch({ evidence: () => undefined });
    const res = runGit(root, base);
    expect(res.status).toBe(1);
    expect(res.stdout.split('\n')[0]).toBe('FAIL path-guard (2 problems)');
    expect(res.stdout).not.toContain('path-guard-author');
    expect(res.stderr).toContain(
      'path-guard: notice: implementer scope starts at the base: no ops/evidence/B2-02a.json at the head',
    );
    expect(res.stderr).toContain('test/spec/ledger/rule.test.ts: added outside the task paths');
  });

  it('a spec_commit that is not an ancestor of the head is not used', () => {
    const { root, base, head } = taskBranch({ evidence: () => undefined });
    // A commit on another branch, not reachable from the head.
    fixtureGit(root, ['switch', '-q', '-c', 'side', base]);
    writeFiles(root, { 'docs/side.md': '# side\n' });
    const side = commitAll(root, 'side');
    fixtureGit(root, ['switch', '-q', '--detach', head]);
    writeFiles(root, {
      'ops/evidence/B2-02a.json': JSON.stringify({ task: 'B2-02a', spec_commit: side }),
    });
    commitAll(root, 'ops(evidence) pointing elsewhere');
    const res = runGit(root, base);
    expect(res.status).toBe(1);
    expect(res.stdout.split('\n')[0]).toBe('FAIL path-guard (2 problems)');
    expect(res.stderr).toContain(`spec_commit ${side} is not an ancestor of the head`);
  });

  it('a spec_commit that is not a descendant of the base is not used', () => {
    const { root, base } = taskBranch({ evidence: () => undefined });
    // The base moved: the branch is rebased onto a newer main commit, but the evidence still
    // names the original base (an ancestor of the new base) as spec_commit.
    fixtureGit(root, ['switch', '-q', '-c', 'newmain', base]);
    writeFiles(root, { 'docs/notes.md': '# main moved\n' });
    const newBase = commitAll(root, 'main moved');
    fixtureGit(root, ['switch', '-q', '-c', 'task', 'main']);
    fixtureGit(root, ['rebase', '-q', newBase]);
    writeFiles(root, {
      'ops/evidence/B2-02a.json': JSON.stringify({ task: 'B2-02a', spec_commit: base }),
    });
    commitAll(root, 'ops(evidence) naming the old base');
    const res = runGit(root, newBase);
    expect(res.status).toBe(1);
    expect(res.stdout.split('\n')[0]).toBe('FAIL path-guard (2 problems)');
    expect(res.stderr).toContain(`is not a descendant of the base ${newBase}`);
  });

  it('an evidence file of another task or without a commit id is not used', () => {
    const other = taskBranch({ evidence: (spec) => ({ task: 'B2-03a', spec_commit: spec }) });
    const wrongTask = runGit(other.root, other.base);
    expect(wrongTask.status).toBe(1);
    expect(wrongTask.stderr).toContain('task is "B2-03a", not "B2-02a"');
    const bogus = taskBranch({ evidence: () => ({ task: 'B2-02a', spec_commit: 'HEAD~1' }) });
    const notId = runGit(bogus.root, bogus.base);
    expect(notId.status).toBe(1);
    expect(notId.stderr).toContain('spec_commit is not a commit id');
  });

  it('rule-test commits touching implementation or other paths fail path-guard-author', () => {
    const { root, base } = taskBranch({
      author: {
        'test/spec/ledger/rule.test.ts': "it('[BR-FUND-13] rule', () => { expect(1).toBe(1); });\n",
        // Implementation inside the task paths: no NotImplemented skeleton.
        'apps/api/src/modules/ledger/post.ts': 'export function post(): number {\n  return 2;\n}\n',
        // Another module, outside the task paths.
        'apps/api/src/modules/orders/sync.ts': 'export const sync = 2;\n',
      },
      implementer: { 'apps/api/src/modules/ledger/more.ts': 'export const more = 1;\n' },
    });
    const res = runGit(root, base);
    expect(res.status).toBe(1);
    expect(res.stdout.split('\n').slice(0, 2)).toEqual([
      'PASS path-guard',
      'FAIL path-guard-author (2 problems)',
    ]);
    expect(res.stderr).toContain(
      'path-guard-author: apps/api/src/modules/ledger/post.ts: implementation path changed in a ' +
        'rule-test commit (before spec_commit) but it is not a NotImplemented skeleton shell',
    );
    expect(res.stderr).toContain(
      'path-guard-author: apps/api/src/modules/orders/sync.ts: changed in a rule-test commit ' +
        "(before spec_commit) outside the rule-test author's paths",
    );
  });

  it('[CR2-02] a new task without test_paths gets no rule-test asset in its rule-test commits', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'test/spec/money/other.test.ts': "it('[BR-X] other', () => { expect(1).toBe(1); });\n",
      'apps/api/src/modules/ledger/post.ts': SKELETON,
    });
    const spec = commitAll(root, 'test(spec): rule tests and skeleton');
    writeFiles(root, {
      'ops/evidence/B2-02d.json': `${JSON.stringify({ task: 'B2-02d', spec_commit: spec }, null, 2)}\n`,
    });
    commitAll(root, 'ops(evidence)');
    const res = guard('run.ts', ['git', '--base', base, '--task', 'B2-02d', '--cwd', root]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(
      'task B2-02d has no test_paths and is not a ledger of the switch baseline',
    );
    expect(res.stderr).toContain('test/spec/money/other.test.ts: changed in a rule-test commit');
  });

  it('a rule-test commit may not remove implementation files', () => {
    const { root, base } = taskBranch({
      author: { 'test/spec/ledger/rule.test.ts': "it('[BR-FUND-13] rule', () => {});\n" },
      authorRemove: ['apps/api/src/modules/ledger/post.ts'],
    });
    const res = runGit(root, base);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(
      'path-guard-author: apps/api/src/modules/ledger/post.ts: removed in a rule-test commit',
    );
  });

  it('rule tests added after spec_commit are still implementer overreach', () => {
    const { root, base } = taskBranch({
      implementer: {
        'apps/api/src/modules/ledger/post.ts': 'export function post(): number {\n  return 2;\n}\n',
        'test/spec/ledger/late.test.ts': "it('[BR-FUND-13] late', () => {});\n",
      },
    });
    const res = runGit(root, base);
    expect(res.status).toBe(1);
    expect(res.stdout.split('\n').slice(0, 2)).toEqual([
      'FAIL path-guard (1 problem)',
      'PASS path-guard-author',
    ]);
    expect(res.stderr).toContain('test/spec/ledger/late.test.ts: added outside the task paths');
  });
});

describe('run.ts git --task: a ledger the pull request adds (owner decision 2026-10-02)', () => {
  const NEW_TASK = LEDGER_TASK.replace('id: B2-02a', 'id: CT-09')
    .replace('type: impl', 'type: contract')
    .replace('  - "apps/api/src/modules/ledger/**"', '  - "contracts/**"');

  function commitAll(root: string, message: string): string {
    fixtureGit(root, ['add', '-A']);
    fixtureGit(root, ['commit', '-q', '-m', message]);
    return fixtureGit(root, ['rev-parse', 'HEAD']);
  }

  const runGit = (root: string, base: string, id: string) =>
    guard('run.ts', ['git', '--base', base, '--task', id, '--cwd', root]);

  it('no ledger in the trusted root: the one the PR adds is read from HEAD', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'ops/tasks/CT-09.yaml': NEW_TASK,
      'contracts/enums/x.yaml': 'x: 1\n',
    });
    commitAll(root, 'task CT-09');
    const res = runGit(root, base, 'CT-09');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.split('\n')[0]).toBe('PASS path-guard');
    expect(res.stderr).toContain(
      'path-guard: notice: task CT-09: no ops/tasks/CT-09.yaml on the base; the ledger is the one this pull request adds',
    );
  });

  it('the head ledger still bounds the paths', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'ops/tasks/CT-09.yaml': NEW_TASK,
      'apps/api/src/modules/orders/sync.ts': 'export const sync = 2;\n',
    });
    commitAll(root, 'task CT-09 overreach');
    const res = runGit(root, base, 'CT-09');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('apps/api/src/modules/orders/sync.ts');
  });

  it('a ledger only in the working tree, or nowhere, is not used', () => {
    const { root, base } = workRepo();
    expect(runGit(root, base, 'CT-09').status).toBe(2);
    writeFiles(root, { 'ops/tasks/CT-09.yaml': NEW_TASK });
    const res = runGit(root, base, 'CT-09');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('HEAD does not add ops/tasks/CT-09.yaml');
  });

  it('a ledger already on the base is never read from the head', () => {
    const { root } = workRepo();
    writeFiles(root, { 'ops/tasks/CT-09.yaml': NEW_TASK });
    const base = commitAll(root, 'ledger on base');
    writeFiles(root, { 'contracts/enums/x.yaml': 'x: 1\n' });
    commitAll(root, 'work');
    const res = runGit(root, base, 'CT-09');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('the trusted copy is stale');
  });

  it('a trusted ledger wins over a widened copy at the head', () => {
    const { root, base } = workRepo();
    writeFiles(root, {
      'ops/tasks/B2-02a.yaml': LEDGER_TASK.replace(
        '  - "apps/api/src/modules/ledger/**"',
        '  - "apps/api/src/modules/ledger/**"\n  - "apps/api/src/modules/orders/**"',
      ),
      'apps/api/src/modules/orders/sync.ts': 'export const sync = 2;\n',
    });
    commitAll(root, 'widen');
    const res = runGit(root, base, 'B2-02a');
    expect(res.status).toBe(1);
    expect(res.stderr).not.toContain('the ledger is the one this pull request adds');
    expect(res.stderr).toContain('apps/api/src/modules/orders/sync.ts');
  });
});
