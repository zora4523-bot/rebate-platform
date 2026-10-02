// Task brief generator (`pnpm ops:brief <id>`; 规划/11 §2.3 step 2, §5.3;
// planning docs/templates/task-brief.md). The brief is the only input of the
// implementer and of the reviewers. It is written to couli-runs/<id>/brief.md
// and never committed.
//
//   node tools/ops/brief.ts <id> [--attempt <n>] [--out <file>]
//
// Exit codes: 0 written, 1 refused (over the size limit, banned term, bad task), 2 usage/internal.
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { writeFileAtomic } from '../lib/fsx.ts';
import { git } from '../lib/git.ts';
import { matchesAny } from '../lib/glob.ts';
import { repoRoot, runsDir, specRef, trustedRoot } from '../lib/paths.ts';
import type { TaskFile } from '../lib/task-file.ts';
import { assertTaskId, CheckError, runGuard, runMain, UsageError } from './cli.ts';
import { globsMayOverlap, literalDir } from './overlap.ts';
import {
  CONTRACTS_FILE,
  contractSection,
  findRule,
  isAcceptanceId,
  isRuleId,
  oneHopRefs,
  ruleTitle,
  splitTableRow,
} from './spec.ts';
import type { Rule, SpecSource } from './spec.ts';
import { readState } from './state.ts';
import type { TaskState } from './state.ts';
import { readTask, riskOfPaths } from './task.ts';
import type { RiskReport } from './task.ts';

/** 规划/11 §5.3: a brief over 24 KB means the task has to be split. */
export const MAX_BRIEF_BYTES = 24 * 1024;
const FAILURE_TAIL_LINES = 200;
const FAILURE_TAIL_BYTES = 8 * 1024;
/** Below this much room for the previous failure the brief is refused instead of squeezed. */
const MIN_FAILURE_TAIL_BYTES = 1024;
const FAILURE_LINE_CHARS = 400;

export type ProtectedPaths = {
  class1_add_only: string[];
  class2_verify_config: string[];
  class3_gates: string[];
};

export type BriefInput = {
  task: TaskFile;
  risk: RiskReport['risk'];
  attempt: number;
  specRef: string;
  state: TaskState | null;
  /** Where gate files (AGENTS.md, protected paths) are read from. */
  rulesRoot: string;
  /** Repository whose history contains `spec_commit`. */
  gitRoot: string;
  spec?: SpecSource;
  /** Byte budget of the previous failure output in section 7 (default 8 KB). */
  failureTailBytes?: number;
};

export function readProtectedPaths(root: string): ProtectedPaths {
  const file = join(root, 'tools', 'guard', 'protected-paths.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProtectedPaths>;
  for (const key of ['class1_add_only', 'class2_verify_config', 'class3_gates'] as const) {
    const list = raw[key];
    if (!Array.isArray(list) || !list.every((g) => typeof g === 'string')) {
      throw new Error(`${file}: ${key} must be a list of globs`);
    }
  }
  return raw as ProtectedPaths;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.turbo', '.tmp', 'coverage']);

function agentsBelow(root: string, dir: string, depth: number, out: Set<string>): void {
  if (depth > 6) return;
  const abs = dir === '' ? root : join(root, dir);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const child = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (existsSync(join(root, child, 'AGENTS.md'))) out.add(`${child}/AGENTS.md`);
    agentsBelow(root, child, depth + 1, out);
  }
}

/**
 * Every AGENTS.md that governs the task's paths: the chain from the repository
 * root down to the directory each glob starts in, plus the ones below it (a
 * glob such as `apps/api/src/modules/**` reaches into every module). Codex only
 * injects the root file by itself (规划/11 §2.4), so the rest must be embedded.
 * Sorted root first.
 */
export function agentsFilesFor(paths: readonly string[], root: string): string[] {
  const found = new Set<string>();
  for (const glob of paths) {
    const dir = literalDir(glob);
    const parts = dir === '' ? [] : dir.split('/');
    for (let i = 0; i <= parts.length; i += 1) {
      const rel = parts.slice(0, i).join('/');
      const file = rel === '' ? 'AGENTS.md' : `${rel}/AGENTS.md`;
      if (existsSync(join(root, file))) found.add(file);
    }
    if (/[*?{[]/.test(glob)) agentsBelow(root, dir, 0, found);
  }
  return [...found].sort((a, b) => {
    const da = a.split('/').length;
    const db = b.split('/').length;
    return da - db || a.localeCompare(b);
  });
}

/** Files of protected class 1 that the rule-test commits added or changed. */
export function ruleTestFiles(
  specCommit: string,
  gitRoot: string,
  class1: readonly string[],
): string[] {
  let base: string;
  try {
    base = git(['merge-base', 'main', specCommit], { cwd: gitRoot });
  } catch {
    // No main yet, or unrelated histories: fall back to the commit itself.
    base = `${specCommit}^`;
  }
  const out = git(
    [
      '-c',
      'core.quotepath=false',
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      base,
      specCommit,
      '--',
    ],
    { cwd: gitRoot },
  );
  return out
    .split('\0')
    .filter((p) => p !== '' && matchesAny(p, class1))
    .sort();
}

function threeColumnRow(rule: Rule): string {
  return rule.rowText.trim();
}

function ruleSection(rule: Rule): string[] {
  const out: string[] = [];
  const status = rule.status === '' ? '' : `（状态：${rule.status}）`;
  out.push(`### ${rule.id}${status}`, '');
  if (isRuleId(rule.id)) {
    out.push('| 编号 | 规则 | 状态 |', '| --- | --- | --- |', threeColumnRow(rule), '');
    if (rule.detailText !== '') out.push(rule.detailText, '');
  } else {
    // Acceptance cases: the row as written in 规划/10 or 规划/01.
    const cells = splitTableRow(rule.rowText) ?? [];
    out.push(`来源：${rule.file}`, '', `|${cells.map(() => ' ').join('|')}|`);
    out.push(`|${cells.map(() => ' --- ').join('|')}|`, rule.rowText.trim(), '');
  }
  return out;
}

function failureTail(file: string, maxBytes: number): string[] {
  if (!existsSync(file)) return [`（上一轮失败输出文件不存在：${file}）`];
  const lines = readFileSync(file, 'utf8').replace(/\n+$/, '').split('\n');
  const tail = lines
    .slice(-FAILURE_TAIL_LINES)
    // The output is untrusted text produced by the code under test: keep it
    // inside the fence and keep single lines from flooding the brief.
    .map((l) => l.replace(/`{3,}/g, "'''").slice(0, FAILURE_LINE_CHARS));
  let bytes = 0;
  let from = tail.length;
  while (from > 0) {
    const size = Buffer.byteLength(tail[from - 1] ?? '', 'utf8') + 1;
    if (bytes + size > maxBytes) break;
    bytes += size;
    from -= 1;
  }
  const kept = tail.slice(from);
  if (from > 0) kept.unshift(`（更早的 ${from} 行已截去）`);
  return kept;
}

function isCommand(entry: string): boolean {
  return /^(pnpm|node|npx|bash|sh)\s/.test(entry);
}

/** Section 2 of an ordinary brief: the full text of each ref and its one-hop references. */
function ruleTexts(task: TaskFile, spec: SpecSource | undefined): string[] {
  const out: string[] = [];
  out.push('## 2. 规则原文（来自 08，版本同 SPEC_REF）', '');
  const rules = task.refs.map((ref) => findRule(ref, spec));
  for (const rule of rules) out.push(...ruleSection(rule));
  out.push('### 一跳引用', '');
  const hopIds: string[] = [];
  for (const rule of rules) {
    for (const id of oneHopRefs(rule)) {
      if (!task.refs.includes(id) && !hopIds.includes(id)) hopIds.push(id);
    }
  }
  const hopRows: string[] = [];
  for (const id of hopIds) {
    try {
      hopRows.push(threeColumnRow(findRule(id, spec)));
    } catch {
      // A mention that is not a rule at SPEC_REF (prose, retired id): nothing to quote.
    }
  }
  if (hopRows.length === 0) out.push('（无）', '');
  else out.push('| 编号 | 规则 | 状态 |', '| --- | --- | --- |', ...hopRows, '');
  out.push(
    '列名、错误码、枚举值以 `contracts/` 与 `db/schema.sql` 为准；技术实现以 ADR-0001 为准。规则原文与它们冲突时不要自行取舍，在输出的 `blocked_reason` 里写明。',
    '',
  );
  return out;
}

/**
 * Section 2 of a contract task brief (owner decision 2026-10-02, ops/approvals.yaml id 17): the
 * 规划/04 sections named in `contract_sections`, verbatim, and the refs as id + title only
 * (no BR text, no one-hop references), so that contract briefs stay under the size limit.
 */
function contractRules(task: TaskFile, spec: SpecSource | undefined): string[] {
  const out: string[] = ['## 2. 契约依据（04 相关节原文；BR 只列编号与标题，版本同 SPEC_REF）', ''];
  out.push('### 涉及的业务规则（只列编号与标题，原文在 08）', '');
  if (task.refs.length === 0) out.push('（无）', '');
  else {
    for (const ref of task.refs) {
      const rule = findRule(ref, spec);
      out.push(`- ${rule.id}：${isRuleId(rule.id) ? ruleTitle(rule) : rule.file}`);
    }
    out.push('');
  }
  out.push(`### 04 相关节（${CONTRACTS_FILE}）`, '');
  if (task.contract_sections.length === 0) {
    out.push('（台账没有点名 04 的章节：按任务标题与第 6 节验收命令判断。）', '');
  }
  for (const section of task.contract_sections) {
    out.push(`<!-- 04 §${section} 全文开始 -->`, '');
    out.push(contractSection(section, spec), '');
    out.push(`<!-- 04 §${section} 全文结束 -->`, '');
  }
  out.push(
    '技术实现以 ADR-0001 为准。04 与 08 原文冲突时不要自行取舍，在输出的 `blocked_reason` 里写明。',
    '',
  );
  return out;
}

/** Renders the brief; pure apart from reading rule text and AGENTS.md files. */
export function renderBrief(input: BriefInput): string {
  const { task, state } = input;
  const out: string[] = [];
  out.push(`# 任务 ${task.id}：${task.title}`, '');
  out.push(`- 仓库：${task.repo}；分支：\`task/${task.id}\`；第 ${input.attempt} 次尝试`);
  out.push(`- 规格版本：\`SPEC_REF=${input.specRef}\``);
  out.push(`- 风险级：${input.risk}；实现：${task.impl}；规则测试作者：${task.tester}`);
  out.push(`- 依赖任务：${task.deps.length === 0 ? '无' : task.deps.join('、')}`, '');

  out.push('## 1. 目标', '');
  const acIds = task.refs.filter((r) => isAcceptanceId(r));
  out.push(
    `${task.title}。关联验收编号：${acIds.length === 0 ? '无（按第 6 节的验收命令与规则测试判定）' : acIds.join('、')}。`,
    '',
  );

  if (task.type === 'contract') out.push(...contractRules(task, input.spec));
  else out.push(...ruleTexts(task, input.spec));

  out.push('## 3. 可以改的路径', '');
  for (const p of task.paths) out.push(`- \`${p}\``);
  out.push('');

  out.push('## 4. 不能改的', '');
  const prot = readProtectedPaths(input.rulesRoot);
  const all = [...prot.class1_add_only, ...prot.class2_verify_config, ...prot.class3_gates];
  const code = (globs: readonly string[]): string => globs.map((g) => `\`${g}\``).join('、');
  // "Relevant" (template §4) = what the implementer could mistake for fair game: protected
  // globs that reach into the allowed paths, and the add-only areas that hold the rule tests
  // named in `accept`. Everything else is outside `paths` and refused by the path guard anyway.
  const inside = all.filter((g) =>
    task.paths.some((p) => globsMayOverlap(p, g.replace(/#.*$/, ''))),
  );
  const testIds = task.accept.filter((a) => !isCommand(a));
  const testAreas = prot.class1_add_only.filter(
    (g) => !inside.includes(g) && testIds.some((t) => globsMayOverlap(t, g)),
  );
  out.push(
    `- 保护路径（落在你的允许路径之内、仍然不能动的）：${inside.length === 0 ? '无' : code(inside)}`,
  );
  if (testAreas.length > 0) {
    out.push(
      `- 保护路径（验收用的规则测试所在，不能改、不能删，也不要为了变绿去动它们）：${code(testAreas)}`,
    );
  }
  out.push(
    '- 其余保护路径都在允许路径之外，同样不能碰；完整清单见 `tools/guard/protected-paths.json`。',
  );
  if (state?.spec_commit) {
    const files = ruleTestFiles(state.spec_commit, input.gitRoot, prot.class1_add_only);
    out.push(
      `- 已有规则测试（\`spec_commit=${state.spec_commit}\` 之后不得改动）：${files.length === 0 ? '无' : files.map((f) => `\`${f}\``).join('、')}`,
    );
  } else {
    out.push('- 已有规则测试：本任务还没有规则测试提交（没有 `spec_commit`）。');
  }
  out.push('- `ops/`、`docs/` 下任何文件；结果只写进 JSON 输出。', '');

  out.push('## 5. 必须遵守的仓库规则', '');
  const agents = agentsFilesFor(task.paths, input.rulesRoot);
  if (agents.length === 0) out.push('（允许路径上没有 AGENTS.md）', '');
  for (const file of agents) {
    out.push(`<!-- ${file} 全文开始 -->`, '');
    out.push(readFileSync(join(input.rulesRoot, file), 'utf8').trim(), '');
    out.push(`<!-- ${file} 全文结束 -->`, '');
  }

  out.push('## 6. 验收命令', '');
  const commands = task.accept.filter(
    (a) => isCommand(a) && a !== 'pnpm verify' && a !== 'pnpm verify:fast',
  );
  out.push('```', 'pnpm verify:fast', ...commands, '```', '');
  out.push(
    `必须变绿的规则测试：${testIds.length === 0 ? '无' : testIds.map((t) => `\`${t}\``).join('、')}。完整验证由编排者在沙箱外跑。沙箱里没有网络，连不上数据库和 Docker，也不能监听端口：不要跑集成测试、迁移和类型生成，需要时写进 \`outside_needed\`。`,
    '',
  );

  out.push('## 7. 上一轮失败输出（第 2 次起才有）', '');
  if (input.attempt >= 2) {
    const tail = state?.last_error
      ? failureTail(state.last_error, input.failureTailBytes ?? FAILURE_TAIL_BYTES)
      : ['（在途状态里没有记录上一轮的失败输出）'];
    out.push('```', ...tail, '```', '');
  } else {
    out.push('（第 1 次尝试，没有上一轮。）', '');
  }

  out.push('## 8. 输出', '');
  out.push('按给定的 JSON 结构返回，字段全部必填：', '');
  out.push('| 字段 | 含义 |', '| --- | --- |');
  out.push('| `task_done` | 是否认为完成 |');
  out.push('| `files_changed` | 改动文件列表 |');
  out.push('| `commands` | 跑过的命令与退出码 |');
  out.push('| `tests_passed` | 验收命令是否通过 |');
  out.push('| `deps_needed` | 需要新装的依赖：名称、版本、理由；没有填空数组 |');
  out.push(
    '| `outside_needed` | 需要编排者在沙箱外跑的命令（迁移、类型生成等）：命令、理由；没有填空数组 |',
  );
  out.push('| `blocked_reason` | 没做完或发现规格冲突时写原因；没有填空串 |');
  out.push('| `notes` | 需要评审方注意的地方，三句以内 |', '');
  out.push(
    'Do not commit. Do not install dependencies. Do not modify any file under `ops/` or `docs/`. 不要运行需要网络、Docker、数据库或监听端口的命令。',
  );
  return `${out.join('\n')}\n`;
}

/** Bytes per numbered `## ` section of a brief (the header is section 0), to see what to split. */
export function sectionSizes(text: string): { title: string; bytes: number }[] {
  const sizes: { title: string; bytes: number }[] = [{ title: '0. 文件头', bytes: 0 }];
  let inFence = false;
  let inEmbed = false;
  for (const line of text.split('\n')) {
    // Quoted material carries its own headings: the failure log sits in a fence, embedded
    // AGENTS.md files between the 全文开始 / 全文结束 markers.
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    if (/^<!-- .+ 全文开始 -->$/.test(line)) inEmbed = true;
    if (/^<!-- .+ 全文结束 -->$/.test(line)) inEmbed = false;
    const heading = inFence || inEmbed ? null : /^## ([1-8]\. .+)$/.exec(line);
    if (heading?.[1] && heading[1].startsWith(`${sizes.length}. `)) {
      sizes.push({ title: heading[1], bytes: 0 });
    }
    const last = sizes[sizes.length - 1];
    if (last) last.bytes += Buffer.byteLength(line, 'utf8') + 1;
  }
  return sizes;
}

export type GenerateOptions = {
  attempt?: number;
  out?: string;
  root?: string;
  spec?: SpecSource;
  risk?: (paths: readonly string[]) => RiskReport;
  /** Tests replace the banned-terms guard; the default runs it from the trusted root. */
  bannedTerms?: (file: string) => { ok: boolean; detail: string };
};

function runBannedTerms(file: string): { ok: boolean; detail: string } {
  const res = runGuard('banned-terms.ts', ['--file', file]);
  if (res.status === 0) return { ok: true, detail: '' };
  if (res.status === 1) return { ok: false, detail: `${res.stdout}${res.stderr}`.trim() };
  throw new Error(`banned-terms.ts exited ${res.status}: ${res.stderr.trim()}`);
}

/** Generates the brief for a task and returns the path it was written to. */
export function generateBrief(id: string, opts: GenerateOptions = {}): string {
  const root = opts.root ?? repoRoot();
  const task = readTask(id, root);
  const state = readState(id);
  const attempt = opts.attempt ?? Math.max(1, state?.attempts.impl ?? 0);
  const report = (opts.risk ?? riskOfPaths)(task.paths);
  const render = (failureTailBytes: number): string =>
    renderBrief({
      task,
      risk: report.risk,
      attempt,
      specRef: specRef(),
      state,
      rulesRoot: opts.root ?? trustedRoot(),
      gitRoot: root,
      failureTailBytes,
      ...(opts.spec ? { spec: opts.spec } : {}),
    });
  let text = render(FAILURE_TAIL_BYTES);
  if (attempt >= 2 && Buffer.byteLength(text, 'utf8') > MAX_BRIEF_BYTES) {
    // A retry must not fail on the size of the failure it reports: the previous output gets
    // whatever room the rest of the brief leaves, newest lines first.
    const room = MAX_BRIEF_BYTES - Buffer.byteLength(render(0), 'utf8');
    if (room >= MIN_FAILURE_TAIL_BYTES) text = render(room);
  }

  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_BRIEF_BYTES) {
    throw new CheckError(
      `任务书 ${bytes} 字节，超过上限 ${MAX_BRIEF_BYTES} 字节（24KB）：任务 ${id} 该拆小（规划/11 §5.3），没有写出文件\n` +
        `各节字节数：${sectionSizes(text)
          .map((s) => `${s.title} ${s.bytes}`)
          .join('；')}`,
    );
  }

  const out = opts.out ?? join(runsDir(), id, 'brief.md');
  // Check the candidate before it can be picked up under its final name.
  const candidate = `${out}.candidate`;
  writeFileAtomic(candidate, text);
  try {
    const verdict = (opts.bannedTerms ?? runBannedTerms)(candidate);
    if (!verdict.ok) {
      throw new CheckError(
        `任务书命中禁用词，没有写出文件；先开同步任务修正规划原文（规划/11 §5.5）：\n${verdict.detail}`,
      );
    }
    renameSync(candidate, out);
  } finally {
    rmSync(candidate, { force: true });
  }
  return out;
}

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { attempt: { type: 'string' }, out: { type: 'string' } },
    allowPositionals: true,
  });
  if (positionals.length !== 1)
    throw new UsageError('brief.ts <id> [--attempt <n>] [--out <file>]');
  const id = assertTaskId(positionals[0]);
  const opts: GenerateOptions = {};
  if (values.attempt !== undefined) {
    if (!/^[1-9][0-9]?$/.test(values.attempt)) throw new UsageError('--attempt must be 1..99');
    opts.attempt = Number.parseInt(values.attempt, 10);
  }
  if (values.out !== undefined) opts.out = values.out;
  const out = generateBrief(id, opts);
  console.error(`任务书已生成（${readFileSync(out).length} 字节）`);
  console.log(out);
  return 0;
}

if (import.meta.main) runMain(main);
