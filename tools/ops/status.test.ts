import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { listTaskIds, loadTask } from '../lib/task-file.ts';
import { acquireOrchestratorLock, releaseOrchestratorLock } from './lock.ts';
import { globsMayOverlap, literalDir, pathSetsMayOverlap } from './overlap.ts';
import { claimTask, updateState } from './state.ts';
import { collectBoard, renderBoard, workingHoursBetween } from './status.ts';
import {
  CLI_TIMEOUT,
  fixedRisk,
  fixtureGit,
  removeDir,
  runCli,
  scratchDir,
  taskYaml,
  writeFiles,
} from './test-helpers.ts';

// Friday 2026-10-02 12:00 in +08:00.
const NOW = new Date('2026-10-02T04:00:00.000Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3600_000);

let base = '';
let root = '';

const task = (id: string, fields: Record<string, string> = {}): string =>
  taskYaml({ id, title: `任务 ${id}`, ...fields });

beforeAll(() => {
  base = scratchDir('status');
  root = join(base, 'repo');
  process.env.COULI_RUNS = join(base, 'runs');
  writeFiles(root, {
    'README.md': 'fixture\n',
    'ops/tasks/S1-01.yaml': task('S1-01', { status: 'done', pr: '7' }),
    // In flight: holds packages/demo/src/**.
    'ops/tasks/S1-02.yaml': task('S1-02', { deps: '[S1-01]' }),
    // Ready: dependency done, paths elsewhere.
    'ops/tasks/S1-03.yaml': task('S1-03', {
      deps: '[S1-01]',
      paths: "\n  - 'apps/api/src/modules/a/**'",
    }),
    // Not ready: overlaps the in-flight task.
    'ops/tasks/S1-04.yaml': task('S1-04', { paths: "\n  - 'packages/demo/**'" }),
    // Not ready: dependency still open.
    'ops/tasks/S1-05.yaml': task('S1-05', {
      deps: '[S1-03]',
      paths: "\n  - 'apps/api/src/modules/b/**'",
    }),
    // Waiting for the owner.
    'ops/tasks/S1-06.yaml': task('S1-06', { paths: "\n  - 'apps/api/src/modules/c/**'" }),
    'ops/tasks/S1-07.yaml': task('S1-07', { paths: "\n  - 'apps/api/src/modules/d/**'" }),
    // Ready: its dependency was archived, which only happens to done tasks.
    'ops/tasks/S1-08.yaml': task('S1-08', { deps: '[S0-01]', paths: "\n  - 'docs/x/**'" }),
    'ops/tasks/archive/202608/S0-01.yaml': task('S0-01', { status: 'done' }),
  });
  fixtureGit(root, ['init', '-q', '-b', 'main']);
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['commit', '-q', '-m', 'fixture']);
  fixtureGit(root, ['branch', 'task/S1-02']);
  fixtureGit(root, ['branch', 'task/S1-99']);

  updateState('S1-02', { state: 'review', last_error: null }, hoursAgo(1));
  claimTask('S1-02', { owner: 'session-a', now: hoursAgo(0.1) });
  updateState('S1-06', { state: 'ask' }, hoursAgo(30));
  updateState('S1-07', { state: 'ask' }, hoursAgo(80));
  updateState('S1-03', { state: 'ready' }, hoursAgo(2));
  updateState('S9-09', { state: 'doing', pid: 2147480000 }, hoursAgo(1));
});

afterAll(() => removeDir(base));

it('decides overlap conservatively from literal prefixes', () => {
  expect(globsMayOverlap('packages/money/src/**', 'packages/money/**')).toBe(true);
  expect(globsMayOverlap('apps/api/src/modules/a/**', 'apps/api/src/modules/b/**')).toBe(false);
  expect(globsMayOverlap('**/*.md', 'db/migrations/0001.sql')).toBe(true);
  expect(globsMayOverlap('db/schema.sql', 'db/schema.sql')).toBe(true);
  expect(pathSetsMayOverlap(['a/**', 'b/**'], ['c/**', 'b/x/*.ts'])).toBe(true);
  expect(literalDir('packages/money/src/**')).toBe('packages/money/src');
  expect(literalDir('packages/money/src/money*.ts')).toBe('packages/money/src');
  expect(literalDir('db/schema.sql')).toBe('db');
  expect(literalDir('**/*.md')).toBe('');
});

it('counts working hours in +08:00 and skips the weekend', () => {
  const friday = new Date('2026-10-02T09:00:00.000Z'); // Friday 17:00 +08:00
  expect(workingHoursBetween(friday, new Date('2026-10-02T12:00:00.000Z'))).toBe(3);
  // Friday 17:00 to Monday 17:00: 7 h on Friday, nothing on the weekend, 17 h on Monday.
  expect(workingHoursBetween(friday, new Date('2026-10-05T09:00:00.000Z'))).toBe(24);
});

it(
  'computes the board from the ledger, the state files, git and the usage ledger',
  () => {
    const board = collectBoard({ root, now: NOW, risk: fixedRisk('RV2') });
    expect(board.done_count).toBe(1);
    expect(board.ready).toEqual(['S1-03', 'S1-08']);
    expect(board.rows.find((r) => r.id === 'S1-02')).toMatchObject({
      state: 'review',
      risk: 'RV2',
      deps: [{ id: 'S1-01', done: true }],
    });
    expect(board.asks.map((a) => [a.id, a.level])).toEqual([
      ['S1-07', '72h'],
      ['S1-06', '24h'],
    ]);
    // Token accounting only: no tier, no weekly estimate (规划/11 §1.3, owner 2026-10-02).
    expect(board.usage).toMatchObject({ calls_today: 0, tokens_today: 0 });
    expect(board.usage).not.toHaveProperty('tier');
    expect(board.breakers).toEqual([]);
    expect(board.remote).toBeNull();
    expect(board.stall).toBeNull();
    expect(board.warnings).toEqual([
      'S9-09 有在途状态文件，但台账里没有这个任务',
      'S9-09 记录的后台进程 2147480000 已不在：按孤儿回收（规划/11 §2.5）',
      '分支 task/S1-99 存在，但没有在途状态文件',
    ]);
  },
  CLI_TIMEOUT,
);

it(
  'renders the ledger table and the fixed lines within the opening-read budget',
  () => {
    const text = renderBoard(collectBoard({ root, now: NOW, risk: fixedRisk('RV2') }));
    expect(text).toContain('# 看板 2026-10-02 12:00（北京时间）');
    expect(text).toContain(
      '| 编号 | 仓库 | 标题 | 风险级 | 实现 / 测试 | 依赖 | 在途状态 | 尝试 | PR |',
    );
    expect(text).toContain(
      '| S1-02 | rebate-platform | 任务 S1-02 | RV2 | codex / claude | S1-01（done） | review | 0 | — |',
    );
    expect(text).not.toContain('| S1-01 |');
    expect(text).toContain('PR/CI: 未接入（没有 GitHub 远端）');
    expect(text).toContain('TODO(规划/11 §2.1)');
    expect(text).toContain('就绪任务（依赖已完成、路径不与在途任务相交）：S1-03、S1-08');
    expect(text).toContain('- S1-07：提出于 2026-09-29 04:00，【红】超过 72 小时');
    expect(text).toContain('- S1-06：提出于 2026-10-01 06:00，超过 24 小时');
    expect(text).toContain('Codex 调用：今日 0 次，0 token（只记账；额度不设限制）');
    expect(text).toContain('失败熔断（每任务 10 次调用、连续 3 次无产出）：未触发');
    expect(text).not.toContain('档位');
    expect(text).toContain('编排锁：无人持有');
    // In-flight rows come first.
    expect(text.indexOf('| S1-02 |')).toBeLessThan(text.indexOf('| S1-03 |'));
    // 规划/11 §5.2: the whole opening read is about 15k tokens; the board takes a small part.
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(6000);
  },
  CLI_TIMEOUT,
);

it(
  'shows the orchestrator lock, a per-task failure breaker and the stall warning',
  () => {
    acquireOrchestratorLock({ session: 'session-a', pid: 4242 }, hoursAgo(0.1));
    updateState('S1-03', { state: 'pr' }, hoursAgo(30));
    updateState('S1-08', { state: 'pr' }, hoursAgo(2));
    // S1-02 ended its last three calls without output (hard timeouts).
    for (const n of [1, 2, 3]) {
      const dir = join(process.env.COULI_RUNS ?? '', 'S1-02', 'attempts', String(n));
      mkdirSync(dir, { recursive: true });
      const at = hoursAgo(1 - n * 0.1).toISOString();
      writeFileSync(
        join(dir, 'meta.json'),
        JSON.stringify({
          mode: 'impl',
          started_at: at,
          finished_at: at,
          exit_code: 124,
          has_output: false,
          validation: 'not-run',
        }),
      );
    }
    const board = collectBoard({ root, now: NOW, risk: fixedRisk('RV1') });
    expect(board.ready).toEqual([]);
    expect(board.stall).toContain('S1-03、S1-08 停在 pr 状态已满 1 个工作日');
    expect(board.breakers).toMatchObject([{ breaker: 'no_output' }]);
    const text = renderBoard(board);
    expect(text).toContain('编排锁：由 session-a（pid 4242） 持有');
    expect(text).toContain('失败熔断（每任务 10 次调用、连续 3 次无产出）：已停的任务不再派工');
    expect(text).toContain('  - S1-02: 连续 3 次调用没有产出');
    expect(text).toContain('停滞告警：');
    expect(releaseOrchestratorLock({ session: 'session-a' })).toBe(true);
  },
  CLI_TIMEOUT,
);

it(
  'prints the real board from the command line, as Markdown and as JSON',
  () => {
    // The real ledger changes with every task: assert on whatever it holds today.
    const open = listTaskIds().filter((id) => loadTask(id).status === 'todo');
    const env = { COULI_RUNS: join(base, 'cli-runs') };
    const md = runCli('status.ts', [], env);
    expect(md.status).toBe(0);
    expect(md.stdout).toContain(
      '| 编号 | 仓库 | 标题 | 风险级 | 实现 / 测试 | 依赖 | 在途状态 | 尝试 | PR |',
    );
    const missing =
      open.length <= 30
        ? open.filter((id) => !md.stdout.includes(`\n| ${id} | ${loadTask(id).repo} | `))
        : [];
    expect(missing).toEqual([]);
    expect(md.stdout.includes('| — | | 没有未完成的任务 |')).toBe(open.length === 0);
    expect(md.stdout).toContain('就绪任务（依赖已完成、路径不与在途任务相交）：');
    // An empty run-state directory: nothing is stopped, there is no quota gate to close.
    expect(md.stdout).toContain('失败熔断（每任务 10 次调用、连续 3 次无产出）：未触发');
    const json = runCli('status.ts', ['--json'], env);
    expect(json.status).toBe(0);
    const board = JSON.parse(json.stdout) as {
      spec_ref: string;
      usage: { calls_today: number };
      breakers: unknown[];
      rows: { id: string; status: string; risk: string }[];
    };
    expect(board.spec_ref).toMatch(/^[0-9a-f]{40}$/);
    expect(board.usage.calls_today).toBe(0);
    expect(board.breakers).toEqual([]);
    expect(
      board.rows
        .filter((r) => r.status === 'todo')
        .map((r) => r.id)
        .sort(),
    ).toEqual([...open].sort());
    expect(board.rows.filter((r) => r.status === 'todo' && r.risk === 'unknown')).toEqual([]);
  },
  CLI_TIMEOUT,
);
