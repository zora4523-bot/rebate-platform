// Session handoff generator (`pnpm ops:handoff`; 规划/11 §5.1, §5.2; planning
// docs/templates/handoff.md). Fills in what can be computed and leaves the
// judgement sections as headed blanks for the orchestrating session.
//
//   node tools/ops/handoff.ts [--out <file>] [--session <name>]
//
// TODO(规划/11 §5.1): move the output to rebate-private/ops-state/handoff/ — blocked on
// the private repository (owner approval #1 is granted, the repository does not exist yet).
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { writeFileAtomic } from '../lib/fsx.ts';
import { git } from '../lib/git.ts';
import { repoRoot, runsDir, specRef, specRepo } from '../lib/paths.ts';
import { CheckError, formatBeijing, runMain } from './cli.ts';
import { orchestratorLockStatus } from './lock.ts';
import type { LockStatus } from './lock.ts';
import { listStates } from './state.ts';
import type { TaskState } from './state.ts';

/** 规划/11 §5.1: a handoff is at most 40 lines. */
export const MAX_HANDOFF_LINES = 40;
/** Lines used by the fixed frame; what is left is shared by the two tables. */
const FRAME_LINES = 31;
const MAX_ASK_ROWS = 4;
const BLANK = '<由编排会话填写>';

export type SpecPosition =
  { known: true; behind: number; onMain: boolean } | { known: false; reason: string };

export type HandoffInput = {
  now: Date;
  session: string;
  startDir: string;
  lock: LockStatus;
  specRef: string;
  spec: SpecPosition;
  states: TaskState[];
};

/**
 * Compares SPEC_REF with the planning repository's local `origin/main`. Nothing
 * is fetched: the answer is as fresh as the last fetch of that repository.
 */
export function specPosition(ref: string, repo: string): SpecPosition {
  try {
    const behind = Number.parseInt(
      git(['rev-list', '--count', `${ref}..origin/main`], { cwd: repo }),
      10,
    );
    let onMain = true;
    try {
      git(['merge-base', '--is-ancestor', ref, 'origin/main'], { cwd: repo });
    } catch {
      onMain = false;
    }
    return { known: true, behind, onMain };
  } catch (err) {
    const first = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
    return { known: false, reason: first.slice(0, 80) };
  }
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function progressRow(s: TaskState): string {
  const a = s.attempts;
  const extra = [
    a.test > 0 ? `，Codex 写测试 ${a.test} 次` : '',
    a.handover > 0 ? `，换家实现 ${a.handover} 次` : '',
  ].join('');
  const step = `${s.state}（实现 ${a.impl} 次${extra}，规则测试评审 ${a['spec-test']} 轮，代码评审 ${a.code} 轮）`;
  const notes: string[] = [];
  if (s.last_error) notes.push(`上一轮失败输出：${s.last_error}`);
  if (s.pid !== null) notes.push(`后台进程 ${s.pid}`);
  return `| ${s.id} | ${cell(step)} | ${BLANK} | ${notes.length === 0 ? '—' : cell(notes.join('；'))} |`;
}

function askRow(s: TaskState): string {
  const created = s.ask_created_at ?? s.updated_at;
  return `| ${BLANK} | ${BLANK} | ${formatBeijing(new Date(created))} | ${s.id} |`;
}

export function renderHandoff(input: HandoffInput): string {
  // What the ledger alone cannot show: tasks that are somewhere in the loop.
  const active = input.states.filter((s) => s.state !== 'ready' && s.state !== 'ask');
  const asks = input.states.filter((s) => s.state === 'ask');

  // The two tables share the lines the frame leaves free.
  const rows = MAX_HANDOFF_LINES - FRAME_LINES;
  const askRows = asks.slice(0, MAX_ASK_ROWS);
  const room = rows - Math.max(1, askRows.length);
  let hidden = asks.length - askRows.length;
  let activeRows = active;
  if (active.length > room || (hidden > 0 && active.length > room - 1)) {
    activeRows = active.slice(0, room - 1);
    hidden += active.length - activeRows.length;
  }

  let lock = '已释放';
  if (input.lock.held) {
    const who = input.lock.holder
      ? `pid ${input.lock.holder.pid}（${input.lock.holder.session}）`
      : '未知进程';
    const until = new Date(Date.parse(input.lock.heartbeat_at) + 20 * 60_000);
    lock = `由 ${who} 持有至 ${formatBeijing(until)}（心跳不再更新则到期）`;
  }
  let spec: string;
  if (!input.spec.known) spec = `无法判断是否最新：${input.spec.reason}`;
  else if (!input.spec.onMain) spec = '不在规划仓库 origin/main 上，须先处理';
  else if (input.spec.behind === 0) spec = '已是规划仓库 main 最新；按本地 origin/main，未 fetch';
  else spec = `落后规划仓库 main ${input.spec.behind} 个提交；按本地 origin/main，原因：${BLANK}`;

  const out: string[] = [];
  out.push(`# 交接 ${formatBeijing(input.now)}`, '');
  out.push(`- 会话：${input.session}；启动目录：${input.startDir}`);
  out.push(`- 编排锁：${lock}`);
  out.push(`- \`SPEC_REF\`：${input.specRef}（${spec}）`, '');
  out.push('## 1. 正在进行、无法从台账看出的事', '');
  out.push('| 任务 | 做到哪一步 | 下一步 | 注意 |', '| --- | --- | --- | --- |');
  if (active.length === 0) out.push(`| — | 没有在途任务 | ${BLANK} | — |`);
  for (const s of activeRows) out.push(progressRow(s));
  if (hidden > 0) out.push(`| … | 另有 ${hidden} 项未列出，见 \`pnpm ops:status\` | | |`);
  out.push('', '## 2. 未决判断', '', BLANK, '');
  out.push('## 3. 坑', '', BLANK, '');
  out.push('## 4. 等负责人的事', '');
  out.push(
    '| 事项 | 类别（规划/11 §7.1） | 提出时间 | 被它卡住的任务 |',
    '| --- | --- | --- | --- |',
  );
  if (askRows.length === 0) out.push(`| — | — | — | 没有 ask 状态的任务 |`);
  for (const s of askRows) out.push(askRow(s));
  out.push('', '## 5. 下一个会话先做什么', '', BLANK, '');
  out.push('## 6. 本次改了哪些规则类文件', '', BLANK);
  const text = `${out.join('\n')}\n`;

  const lines = out.length;
  if (lines > MAX_HANDOFF_LINES) {
    throw new CheckError(`交接 ${lines} 行，超过上限 ${MAX_HANDOFF_LINES} 行（规划/11 §5.1）`);
  }
  // The handoff points at tools/agent/codex-run.sh instead of carrying commands.
  if (/codex\s+exec/.test(text)) throw new CheckError('交接里不得出现 Codex 命令（规划/11 §5.1）');
  return text;
}

function stamp(now: Date): string {
  const s = formatBeijing(now);
  return `${s.slice(0, 4)}${s.slice(5, 7)}${s.slice(8, 10)}-${s.slice(11, 13)}${s.slice(14, 16)}`;
}

export type HandoffResult = { current: string; copy: string; text: string };

export function generateHandoff(
  opts: { now?: Date; session?: string; out?: string } = {},
): HandoffResult {
  const now = opts.now ?? new Date();
  const root = repoRoot();
  const rel = relative(root, process.cwd());
  const inside = rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
  const ref = specRef();
  const text = renderHandoff({
    now,
    session: opts.session ?? BLANK,
    startDir: inside ? 'rebate-platform' : process.cwd(),
    lock: orchestratorLockStatus(now),
    specRef: ref,
    spec: specPosition(ref, specRepo()),
    states: listStates(),
  });
  const dir = join(runsDir(), 'handoff');
  const current = opts.out ?? join(dir, 'CURRENT.md');
  const copy = join(dir, `${stamp(now)}.md`);
  writeFileAtomic(copy, text);
  writeFileAtomic(current, text);
  return { current, copy, text };
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: 'string' }, session: { type: 'string' } },
  });
  const opts: { session?: string; out?: string } = {};
  if (values.session !== undefined) opts.session = values.session;
  if (values.out !== undefined) opts.out = values.out;
  const res = generateHandoff(opts);
  console.error(
    '交接已生成；第 2、3、5、6 节与表里的空格由编排会话补写。写之前先落盘在途状态、写入批准记录、释放编排锁（模板开头三件事）。',
  );
  console.log(res.current);
  console.log(res.copy);
  return 0;
}

if (import.meta.main) runMain(main);
