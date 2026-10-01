import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateHandoff, MAX_HANDOFF_LINES, renderHandoff, specPosition } from './handoff.ts';
import type { HandoffInput } from './handoff.ts';
import { acquireOrchestratorLock } from './lock.ts';
import { updateState } from './state.ts';
import type { TaskState } from './state.ts';
import {
  CLI_TIMEOUT,
  fixtureGit,
  removeDir,
  runCli,
  scratchDir,
  writeFiles,
} from './test-helpers.ts';

const NOW = new Date('2026-10-02T04:05:00.000Z'); // 12:05 in +08:00
const REF = 'cbd8f06fa7ab14631f1e7f4dd9106fda8bef749b';

function state(id: string, over: Partial<TaskState> = {}): TaskState {
  return {
    id,
    state: 'review',
    attempts: { impl: 2, review: 1 },
    spec_commit: null,
    pid: null,
    started_at: null,
    owner_session: null,
    lease_until: null,
    ask_created_at: null,
    last_error: null,
    updated_at: '2026-10-02T03:00:00.000Z',
    ...over,
  };
}

function input(states: TaskState[], over: Partial<HandoffInput> = {}): HandoffInput {
  return {
    now: NOW,
    session: '编排-1002-上午',
    startDir: 'rebate-platform',
    lock: { held: false },
    specRef: REF,
    spec: { known: true, behind: 0, onMain: true },
    states,
    ...over,
  };
}

const lineCount = (text: string): number => text.trimEnd().split('\n').length;

let base = '';

beforeAll(() => {
  base = scratchDir('handoff');
  process.env.COULI_RUNS = join(base, 'runs');
});
afterAll(() => removeDir(base));

it('fills the computable parts and leaves the judgement sections blank', () => {
  const text = renderHandoff(
    input([
      state('B2-01a', { last_error: '/runs/B2-01a/verify/2/log.txt', pid: 4242 }),
      state('B2-03', { state: 'ask', ask_created_at: '2026-10-01T02:00:00.000Z' }),
      state('B2-04', { state: 'ready' }),
    ]),
  );
  const marks = [
    '# 交接 2026-10-02 12:05',
    '- 会话：编排-1002-上午；启动目录：rebate-platform',
    '- 编排锁：已释放',
    `- \`SPEC_REF\`：${REF}（已是规划仓库 main 最新；按本地 origin/main，未 fetch）`,
    '## 1. 正在进行、无法从台账看出的事',
    '| 任务 | 做到哪一步 | 下一步 | 注意 |',
    '| B2-01a | review（实现 2 次，评审 1 轮） | <由编排会话填写> | 上一轮失败输出：/runs/B2-01a/verify/2/log.txt；后台进程 4242 |',
    '## 2. 未决判断\n\n<由编排会话填写>',
    '## 3. 坑\n\n<由编排会话填写>',
    '## 4. 等负责人的事',
    '| 事项 | 类别（规划/11 §7.1） | 提出时间 | 被它卡住的任务 |',
    '| <由编排会话填写> | <由编排会话填写> | 2026-10-01 10:00 | B2-03 |',
    '## 5. 下一个会话先做什么\n\n<由编排会话填写>',
    '## 6. 本次改了哪些规则类文件\n\n<由编排会话填写>',
  ];
  const positions = marks.map((m) => text.indexOf(m));
  expect(positions.filter((p) => p < 0)).toEqual([]);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  // Queued tasks are visible on the board; they do not belong here.
  expect(text).not.toContain('B2-04');
  expect(lineCount(text)).toBeLessThanOrEqual(MAX_HANDOFF_LINES);
});

it('describes the lock and a SPEC_REF that fell behind', () => {
  const text = renderHandoff(
    input([], {
      lock: {
        held: true,
        stale: false,
        heartbeat_at: '2026-10-02T04:00:00.000Z',
        holder: {
          session: 'tick',
          pid: 777,
          acquired_at: '2026-10-02T03:00:00.000Z',
          heartbeat_at: '2026-10-02T04:00:00.000Z',
        },
      },
      spec: { known: true, behind: 3, onMain: true },
    }),
  );
  expect(text).toContain('- 编排锁：由 pid 777（tick） 持有至 2026-10-02 12:20');
  expect(text).toContain('落后规划仓库 main 3 个提交；按本地 origin/main，原因：<由编排会话填写>');
  expect(text).toContain('| — | 没有在途任务 | <由编排会话填写> | — |');
  expect(text).toContain('| — | — | — | 没有 ask 状态的任务 |');
  // 31 lines of frame plus one placeholder row per table.
  expect(lineCount(text)).toBe(33);
  expect(renderHandoff(input([], { spec: { known: false, reason: 'no origin/main' } }))).toContain(
    '无法判断是否最新：no origin/main',
  );
  expect(renderHandoff(input([], { spec: { known: true, behind: 0, onMain: false } }))).toContain(
    '不在规划仓库 origin/main 上',
  );
});

it('never exceeds 40 lines, however many tasks are in flight', () => {
  const many = [
    ...Array.from({ length: 12 }, (_, i) => state(`B2-${String(i + 10)}`)),
    ...Array.from({ length: 7 }, (_, i) =>
      state(`B3-${String(i + 10)}`, { state: 'ask', ask_created_at: '2026-10-01T02:00:00.000Z' }),
    ),
  ];
  const text = renderHandoff(input(many));
  expect(lineCount(text)).toBe(MAX_HANDOFF_LINES);
  expect(text).toContain('| … | 另有 11 项未列出，见 `pnpm ops:status` | | |');
  expect(text).toContain('| B2-13 |');
  expect(text).not.toContain('| B2-14 |');
  expect(text).toContain('| B3-13 |');

  const exact = renderHandoff(
    input(Array.from({ length: 8 }, (_, i) => state(`B2-${String(i + 10)}`))),
  );
  expect(lineCount(exact)).toBe(MAX_HANDOFF_LINES);
  expect(exact).not.toContain('未列出');
});

it('refuses to carry a Codex command', () => {
  const leaky = state('B2-01a', { last_error: 'codex exec -s workspace-write …' });
  expect(() => renderHandoff(input([leaky]))).toThrow(/不得出现 Codex 命令/);
});

it(
  'compares SPEC_REF with origin/main of the planning repository',
  () => {
    const repo = join(base, 'planning');
    writeFiles(repo, { 'a.md': 'a\n' });
    fixtureGit(repo, ['init', '-q', '-b', 'main']);
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '-q', '-m', 'a']);
    const first = fixtureGit(repo, ['rev-parse', 'HEAD']);
    expect(specPosition(first, repo)).toMatchObject({ known: false });
    writeFiles(repo, { 'b.md': 'b\n' });
    fixtureGit(repo, ['add', '-A']);
    fixtureGit(repo, ['commit', '-q', '-m', 'b']);
    const second = fixtureGit(repo, ['rev-parse', 'HEAD']);
    fixtureGit(repo, ['update-ref', 'refs/remotes/origin/main', second]);
    expect(specPosition(first, repo)).toEqual({ known: true, behind: 1, onMain: true });
    expect(specPosition(second, repo)).toEqual({ known: true, behind: 0, onMain: true });
    fixtureGit(repo, ['update-ref', 'refs/remotes/origin/main', first]);
    expect(specPosition(second, repo)).toEqual({ known: true, behind: 0, onMain: false });
  },
  CLI_TIMEOUT,
);

it(
  'writes CURRENT.md and a timestamped copy under couli-runs/handoff',
  () => {
    updateState('B2-01a', { state: 'verify' }, NOW);
    acquireOrchestratorLock({ session: 'session-a', pid: 99 }, NOW);
    const res = generateHandoff({ now: NOW, session: 's-1' });
    expect(res.current).toBe(join(base, 'runs', 'handoff', 'CURRENT.md'));
    expect(res.copy).toBe(join(base, 'runs', 'handoff', '20261002-1205.md'));
    expect(readFileSync(res.current, 'utf8')).toBe(res.text);
    expect(readFileSync(res.copy, 'utf8')).toBe(res.text);
    expect(res.text).toContain('- 会话：s-1；启动目录：');
    expect(res.text).toContain('| B2-01a | verify（实现 0 次，评审 0 轮） |');
    expect(res.text).toContain('- 编排锁：由 pid 99（session-a） 持有至 2026-10-02 12:25');
  },
  CLI_TIMEOUT,
);

it(
  'runs from the command line and prints both paths',
  () => {
    const runs = join(base, 'cli-runs');
    const res = runCli('handoff.ts', ['--session', 'cli'], { COULI_RUNS: runs });
    expect(res.status).toBe(0);
    const [current, copy] = res.stdout.trim().split('\n');
    expect(current).toBe(join(runs, 'handoff', 'CURRENT.md'));
    expect(copy).toMatch(/handoff\/20\d{6}-\d{4}\.md$/);
    expect(existsSync(copy ?? '')).toBe(true);
    const text = readFileSync(current ?? '', 'utf8');
    expect(text).toContain('- 会话：cli；启动目录：');
    expect(text).toMatch(/- `SPEC_REF`：[0-9a-f]{40}（/);
    expect(lineCount(text)).toBeLessThanOrEqual(MAX_HANDOFF_LINES);
    expect(runCli('handoff.ts', ['--bogus'], { COULI_RUNS: runs }).status).toBe(2);
  },
  CLI_TIMEOUT,
);
