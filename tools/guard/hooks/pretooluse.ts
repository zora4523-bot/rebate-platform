// PreToolUse hook for Claude Code sessions (规划/11 §8, 规划/02 §12.7).
//
// Input (stdin): the PreToolUse JSON with `tool_name`, `tool_input` and `cwd`.
// Output:
//   allow -> exit 0, nothing printed (the normal permission flow still applies);
//   ask   -> exit 0, JSON with hookSpecificOutput.permissionDecision = "ask";
//   deny  -> exit 2, the reason on stderr (and the same JSON on stdout).
//
// The decision is a pure function of the input and an explicit context. In particular the
// COULI_CODEX_WRAPPER marker is read from the inspected command's own env prefix, never from
// the environment of the hook process.
//
// This file is NOT installed by the repository; see INSTALL.md next to it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveCommand, programName, splitCommands } from './shell.ts';
import type { SimpleCommand, Word } from './shell.ts';

export type HookInput = { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };

export type Decision = { decision: 'allow' | 'ask' | 'deny'; reason: string };

export type HookContext = {
  /** Home directory used to expand `~` and `$HOME`. */
  home: string;
  /** Directories in which deleting files needs no confirmation (the project). */
  workspaceRoots: string[];
  /** Scratch directories in which deleting files needs no confirmation. */
  tmpRoots: string[];
  /** Production hosts; any tool input that mentions one needs confirmation. */
  prodHosts: string[];
  /** Current branch of the repository at `dir`, or null when unknown. */
  currentBranch: (dir: string) => string | null;
  /**
   * Where a non-compliant `codex exec` is denied. null (the default) means everywhere; a list
   * limits the denial to sessions and commands inside those directories and asks elsewhere.
   */
  codexDenyRoots: string[] | null;
};

type Level = 'ask' | 'deny';
type Finding = { level: Level; reason: string };

type State = {
  ctx: HookContext;
  findings: Finding[];
  /** Working directory while walking a command chain; null once it cannot be known. */
  cwd: string | null;
  /** The whole command text as given to the tool. */
  raw: string;
};

const MAX_DEPTH = 6;
const DANGEROUS_FLAG = '--dangerously-bypass-approvals-and-sandbox';
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const TEXT_ONLY = new Set(['echo', 'printf']);
const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash']);
const PROTECTED_BRANCHES = new Set(['main', 'master']);
// Same key material as the .gitignore of this repository (规划/11 §8).
const KEY_EXTENSIONS = [
  '.p12',
  '.jks',
  '.p7b',
  '.mobileprovision',
  '.pem',
  '.key',
  '.pfx',
  '.keystore',
  '.cer',
  '.csr',
];
// Interpreters whose inline script (`-e` / `-c`) can start a program the parser cannot see.
const INTERPRETERS = new Set(['python', 'python3', 'node', 'perl', 'ruby', 'php', 'deno', 'bun']);

const CODEX_SAFE_FLAGS = new Set(['--version', '-V', '--help', '-h']);
const CODEX_SAFE_SUBCOMMANDS = new Set(['help', 'sandbox', 'completion']);
// Subcommands listed by `codex --help` (codex-cli 0.154.0), other than exec / e.
const CODEX_SUBCOMMANDS = new Set([
  'agents',
  'review',
  'login',
  'logout',
  'mcp',
  'plugin',
  'app-server',
  'remote-control',
  'app',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'apply',
  'a',
  'resume',
  'queue',
  'archive',
  'delete',
  'migrate-rollouts',
  'unarchive',
  'fork',
  'cloud',
  'exec-server',
  'features',
  'help',
]);
// Options of `codex` that consume the following argument (so it is not taken for a subcommand).
const CODEX_VALUE_FLAGS = new Set([
  '-c',
  '--config',
  '-m',
  '--model',
  '-C',
  '--cd',
  '-s',
  '--sandbox',
  '-p',
  '--profile',
  '-a',
  '--ask-for-approval',
  '-i',
  '--image',
  '-o',
  '--output-last-message',
  '--output-schema',
  '--enable',
  '--disable',
  '--add-dir',
  '--color',
  '--local-provider',
  '--remote',
  '--remote-auth-token-env',
  '--thread-source',
]);

// The only sandbox-related configuration key the wrapper passes with `-c` (规划/11 §2.4).
const CODEX_ALLOWED_SANDBOX_KEY = 'sandbox_workspace_write.exclude_slash_tmp';

/** Keys of the `-c key=value` / `--config key=value` overrides, lower-cased and unquoted. */
function codexConfigKeys(args: readonly string[]): string[] {
  const keys: string[] = [];
  const push = (pair: string): void => {
    const eq = pair.indexOf('=');
    const key = (eq === -1 ? pair : pair.slice(0, eq)).replace(/["'\s]/g, '').toLowerCase();
    keys.push(key);
  };
  args.forEach((arg, i) => {
    if (arg === '-c' || arg === '--config') push(args[i + 1] ?? '');
    else if (arg.startsWith('--config=')) push(arg.slice('--config='.length));
    else if (/^-c./.test(arg)) push(arg.slice(2).replace(/^=/, ''));
  });
  return keys;
}

function add(st: State, level: Level, reason: string): void {
  if (!st.findings.some((f) => f.level === level && f.reason === reason)) {
    st.findings.push({ level, reason });
  }
}

// ---------------------------------------------------------------------------------------------
// Sensitive files (规划/02 §12.7, 规划/11 §8): .env*, key and certificate files, ~/.ssh
// ---------------------------------------------------------------------------------------------

/** Reason when the path names a secret-bearing file, else null. */
export function sensitivePath(path: string): string | null {
  const segments = path.split(/[/:=]/).filter((s) => s !== '');
  if (segments.includes('.ssh')) return '访问 ~/.ssh 下的密钥文件';
  for (const segment of segments) {
    const name = segment.toLowerCase();
    if (name.startsWith('.env') && name !== '.env.example') {
      return `读取环境文件 ${segment}（只有 .env.example 可以直接读）`;
    }
    if (KEY_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      return `读取密钥或证书文件 ${segment}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------------------------

function codexSubcommand(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--') return args[i + 1] ?? null;
    if (arg.startsWith('-')) {
      if (CODEX_VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    return arg;
  }
  return null;
}

/** Problems of a `codex exec` invocation; empty when it matches what codex-run.sh would run. */
export function codexExecProblems(args: readonly string[], env: Record<string, string>): string[] {
  const problems: string[] = [];
  if (env['COULI_CODEX_WRAPPER'] !== '1') {
    problems.push('命令自身的环境前缀里没有 COULI_CODEX_WRAPPER=1');
  }
  const sandboxes: string[] = [];
  args.forEach((arg, i) => {
    if (arg === '-s' || arg === '--sandbox') sandboxes.push(args[i + 1] ?? '');
    else if (arg.startsWith('--sandbox=')) sandboxes.push(arg.slice('--sandbox='.length));
    else if (/^-s./.test(arg)) sandboxes.push(arg.slice(2).replace(/^=/, ''));
  });
  if (sandboxes.length === 0) {
    problems.push('没有显式沙箱参数 -s / --sandbox');
  } else if (!sandboxes.every((v) => v === 'read-only' || v === 'workspace-write')) {
    problems.push(`沙箱取值只能是 read-only 或 workspace-write（现为 ${sandboxes.join('、')}）`);
  }
  if (!args.includes('--ignore-rules')) problems.push('缺少 --ignore-rules');
  if (!args.includes('--ignore-user-config')) problems.push('缺少 --ignore-user-config');
  const joined = args.join(' ');
  // The key may be quoted inside an inline TOML table: `{"network_access"=true}`.
  if (/network_access["']?\s*=\s*["']?true/i.test(joined)) {
    problems.push('打开了 network_access=true');
  }
  if (args.some((a) => a === '--add-dir' || a.startsWith('--add-dir='))) {
    problems.push('使用了 --add-dir');
  }
  if (args.some((a) => a === '--worktree' || a.startsWith('--worktree='))) {
    problems.push('使用了 --worktree');
  }
  if (/danger-full-access/i.test(joined)) problems.push('出现 danger-full-access');
  if (/sandbox_mode["']?\s*=/i.test(joined)) problems.push('透传了 sandbox_mode=');

  // Beyond the list in 规划/11 §8 (tightening only; checked against `codex exec --help` of
  // codex-cli 0.154.0): other spellings that switch the sandbox off or change where the
  // configuration comes from. The wrapper passes none of them.
  const bypass = args.filter((a) => a === '--yolo' || a.startsWith('--dangerously-'));
  if (bypass.length > 0) problems.push(`使用了跳过沙箱或确认的参数 ${bypass.join('、')}`);
  if (args.some((a) => a === '-p' || a === '--profile' || /^(--profile=|-p.)/.test(a))) {
    problems.push('使用了 --profile（会叠加另一份配置）');
  }
  if (args.includes('--approve-for-me')) problems.push('使用了 --approve-for-me');
  const sandboxKeys = codexConfigKeys(args).filter(
    (key) => key.startsWith('sandbox') && key !== CODEX_ALLOWED_SANDBOX_KEY,
  );
  if (sandboxKeys.length > 0) {
    problems.push(
      `用 -c 改了沙箱配置 ${[...new Set(sandboxKeys)].join('、')}（只允许 ${CODEX_ALLOWED_SANDBOX_KEY}）`,
    );
  }
  return problems;
}

/** Whether a non-compliant `codex exec` is denied (true) or left to the owner (false). */
function codexDenied(st: State, args: readonly string[]): boolean {
  const roots = st.ctx.codexDenyRoots;
  if (roots === null) return true;
  const places: (string | null)[] = [st.cwd, ...st.ctx.workspaceRoots];
  args.forEach((arg, i) => {
    let dir: string | null = null;
    if (arg === '-C' || arg === '--cd') dir = args[i + 1] ?? null;
    else if (arg.startsWith('--cd=')) dir = arg.slice('--cd='.length);
    else if (/^-C./.test(arg)) dir = arg.slice(2);
    // A target that cannot be resolved counts as inside: deny.
    if (dir !== null)
      places.push(st.cwd === null || /[$`]/.test(dir) ? (roots[0] ?? null) : resolve(st.cwd, dir));
  });
  if (st.cwd === null) return true;
  return places.some((place) => place !== null && roots.some((root) => isInside(place, root)));
}

/** True when the arguments run `codex exec` (alias `e`), also behind an option we do not know. */
function isCodexExec(args: readonly string[]): boolean {
  const sub = codexSubcommand(args);
  if (sub === 'exec' || sub === 'e') return true;
  if (sub === null || CODEX_SUBCOMMANDS.has(sub)) return false;
  // `codex --some-new-option value exec ...`: the value was taken for the subcommand.
  const end = args.indexOf('--');
  const head = end === -1 ? args : args.slice(0, end);
  return head.some((a) => a === 'exec' || a === 'e');
}

function checkCodex(st: State, args: readonly string[], env: Record<string, string>): void {
  const sub = codexSubcommand(args);
  if (isCodexExec(args)) {
    const problems = codexExecProblems(args, env);
    if (problems.length > 0) {
      add(
        st,
        codexDenied(st, args) ? 'deny' : 'ask',
        `codex exec 只能经 tools/agent/codex-run.sh 调用（规划/11 §2.4）：${problems.join('；')}`,
      );
      return;
    }
    // Even a compliant command line is not the wrapper: the wrapper's own `codex exec` runs
    // inside its script and never passes through this hook, so a hand-typed one bypasses the
    // position assertion, the timeout and group kill, the usage ledger and the output
    // validation. The owner decides (a first-run self-check is the one legitimate case).
    add(
      st,
      'ask',
      'codex exec 不经 tools/agent/codex-run.sh（参数合规，但绕过位置断言、超时击杀、额度账本与产出校验）：改用包装脚本，或由负责人确认这次直接调用',
    );
    return;
  }
  if (sub === null) {
    if (args.length > 0 && args.every((a) => CODEX_SAFE_FLAGS.has(a))) return;
    add(st, 'ask', '直接启动 codex（不经包装脚本，按本机默认配置是全盘读写加联网）');
    return;
  }
  if (!CODEX_SAFE_SUBCOMMANDS.has(sub)) {
    add(st, 'ask', `codex ${sub.slice(0, 40)} 不经包装脚本运行（按本机默认配置是全盘读写加联网）`);
  }
}

// ---------------------------------------------------------------------------------------------
// gh, git push
// ---------------------------------------------------------------------------------------------

function positionals(args: readonly string[], valueFlags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg.startsWith('-')) {
      if (valueFlags.includes(arg)) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function checkGh(st: State, args: readonly string[]): void {
  const [group, action] = positionals(args, ['-R', '--repo', '--hostname']);
  if (
    group === 'repo' &&
    ['create', 'delete', 'edit', 'rename', 'archive'].includes(action ?? '')
  ) {
    add(st, 'ask', `gh repo ${action}：建库、删库或改仓库设置`);
  } else if (group === 'secret') {
    add(st, 'ask', 'gh secret：读写仓库密钥');
  } else if (group === 'api') {
    let method = '';
    args.forEach((arg, i) => {
      if (arg === '-X' || arg === '--method') method = args[i + 1] ?? '';
      else if (arg.startsWith('--method=')) method = arg.slice('--method='.length);
      else if (/^-X./.test(arg)) method = arg.slice(2).replace(/^=/, '');
    });
    // A body makes `gh api` POST even without -X (statuses, labels, rulesets, comments).
    const hasBody = args.some(
      (a) =>
        ['-f', '-F', '--field', '--raw-field', '--input'].includes(a) ||
        /^(--field=|--raw-field=|--input=|-f.|-F.)/.test(a),
    );
    const effective = method === '' && hasBody ? 'POST' : method.toUpperCase();
    if (['DELETE', 'PUT', 'PATCH', 'POST'].includes(effective)) {
      add(
        st,
        'ask',
        `gh api ${effective}：经接口写入、修改或删除 GitHub 上的内容（含提交状态、标签、规则集）`,
      );
    }
  } else if (group === 'pr' && action === 'merge' && args.includes('--admin')) {
    add(st, 'ask', 'gh pr merge --admin：绕过必过检查合并');
  } else if (group === 'pr' && action === 'merge' && args.includes('--auto')) {
    add(st, 'ask', 'gh pr merge --auto：自动合并不受 merge.sh 控制（规划/11 §3.2）');
  } else if ((group === 'pr' || group === 'issue') && action === 'edit' && labelsApproval(args)) {
    add(
      st,
      'ask',
      `gh ${group} edit：加 owner-approved-* 标签等于替负责人批准保护路径改动（规划/11 §4.4）`,
    );
  } else if (group === 'label' && action !== 'list') {
    add(st, 'ask', 'gh label：改标签定义');
  } else if (group === 'run' && ['rerun', 'cancel', 'delete'].includes(action ?? '')) {
    add(st, 'ask', `gh run ${action}：重跑或改动 CI 运行（规划/11 §3.2 不许重跑到绿）`);
  } else if (group === 'release' && action !== 'list' && action !== 'view') {
    add(st, 'ask', 'gh release：发布或修改版本');
  } else if (group === 'workflow' && ['run', 'enable', 'disable'].includes(action ?? '')) {
    add(st, 'ask', `gh workflow ${action}：手动触发或启停工作流`);
  } else if (group === 'auth' && (action === 'token' || args.includes('--show-token'))) {
    add(st, 'ask', 'gh auth：输出登录令牌');
  }
}

/** True when the arguments add an `owner-approved-*` label (or a label we cannot read). */
function labelsApproval(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    let value: string | null = null;
    if (arg === '--add-label') value = args[i + 1] ?? '';
    else if (arg.startsWith('--add-label=')) value = arg.slice('--add-label='.length);
    if (value === null) continue;
    if (/owner-approved/i.test(value) || /[$`]/.test(value)) return true;
  }
  return false;
}

const GIT_GLOBAL_VALUE_FLAGS = [
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
];
const GIT_PUSH_VALUE_FLAGS = ['-o', '--push-option', '--repo', '--receive-pack', '--exec'];

function checkGit(st: State, argvWords: readonly Word[]): void {
  const args = argvWords.map((w) => w.text);
  const dynamicWords = argvWords.filter((w) => w.dynamic).map((w) => w.text);
  // Find the subcommand, remembering `-C <dir>` and `-c key=value`.
  let dir = st.cwd;
  let hooksOverridden = false;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('-')) break;
    if (arg === '-C') dir = dir === null ? null : resolve(dir, args[i + 1] ?? '.');
    if (arg === '-c' && /^core\.hookspath=/i.test(args[i + 1] ?? '')) hooksOverridden = true;
    if (/^-c=?core\.hookspath=/i.test(arg)) hooksOverridden = true;
    if (GIT_GLOBAL_VALUE_FLAGS.includes(arg)) i++;
  }
  const sub = args[i];
  if (hooksOverridden) {
    add(st, 'ask', 'git -c core.hooksPath=…：绕过 .githooks 的提交前密钥检查');
  }
  if (sub === 'config' && args.slice(i + 1).some((a) => /^core\.hookspath$/i.test(a))) {
    add(st, 'ask', 'git config core.hooksPath：改动提交钩子的位置');
  }
  if (sub === 'commit' || sub === 'merge') {
    const flags = args.slice(i + 1).filter((a) => a.startsWith('-'));
    if (flags.some((f) => f === '--no-verify' || (/^-[a-zA-Z]+$/.test(f) && f.includes('n')))) {
      add(st, 'ask', `git ${sub} --no-verify：跳过提交前密钥检查（规划/11 §8）`);
    }
  }
  if (sub !== 'push') return;
  const rest = args.slice(i + 1);
  const flags = rest.filter((a) => a.startsWith('-'));
  const refs = positionals(rest, GIT_PUSH_VALUE_FLAGS).slice(1);

  const forced =
    flags.some(
      (f) =>
        f === '--force' ||
        f.startsWith('--force-with-lease') ||
        f === '--force-if-includes' ||
        f === '--mirror' ||
        (/^-[a-zA-Z]+$/.test(f) && f.includes('f')),
    ) || refs.some((r) => r.startsWith('+'));
  if (forced) add(st, 'ask', 'git push 强制推送');

  if (
    flags.some((f) => f === '--delete' || (/^-[a-zA-Z]+$/.test(f) && f.includes('d'))) ||
    refs.some((r) => r.startsWith(':'))
  ) {
    add(st, 'ask', 'git push 删除远端分支');
  }

  if (flags.includes('--all') || flags.includes('--branches')) {
    add(st, 'ask', 'git push --all：会直接推送 main');
    return;
  }
  const targets = refs.map((r) => {
    const dst = r.replace(/^\+/, '').split(':').pop() ?? '';
    return dst.replace(/^refs\/heads\//, '');
  });
  // A refspec with a wildcard, a variable or a substitution can name main.
  const dynamicRefs = refs.some((r) => /[*$`]/.test(r) || dynamicWords.includes(r));
  if (dynamicRefs || flags.includes('--prune')) {
    add(st, 'ask', 'git push 的目标分支无法静态判断（通配、变量或命令替换），可能推到 main');
    return;
  }
  const implicit = refs.length === 0 || targets.some((t) => t === 'HEAD' || t === '@' || t === '');
  if (targets.some((t) => PROTECTED_BRANCHES.has(t))) {
    add(st, 'ask', '直接推送 main（main 只经 PR 合并）');
  } else if (implicit && dir !== null) {
    const branch = st.ctx.currentBranch(dir);
    if (branch !== null && PROTECTED_BRANCHES.has(branch)) {
      add(st, 'ask', '当前在 main 分支上执行 git push（main 只经 PR 合并）');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Deleting outside the workspace
// ---------------------------------------------------------------------------------------------

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** Absolute path of a deletion target, or null when it cannot be determined statically. */
function resolveTarget(st: State, word: Word): string | null {
  let text = word.text;
  const home = st.ctx.home;
  text = text.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  if (st.cwd !== null) text = text.replace(/^\$\{?PWD\}?(?=\/|$)/, st.cwd);
  const tmp = st.ctx.tmpRoots[0];
  if (tmp !== undefined) text = text.replace(/^\$\{?TMPDIR\}?(?=\/|$)/, tmp);
  if (/[$`]/.test(text) || text.startsWith('~')) return null;
  if (word.dynamic && text === word.text) return null;
  // A glob can only match below its literal directory prefix.
  const segments = text.split('/');
  const globAt = segments.findIndex((s) => /[*?[]/.test(s));
  if (globAt !== -1)
    text = segments.slice(0, globAt).join('/') || (text.startsWith('/') ? '/' : '.');
  if (isAbsolute(text)) return resolve(text);
  return st.cwd === null ? null : resolve(st.cwd, text);
}

function checkDeletionTargets(st: State, program: string, targets: readonly Word[]): void {
  for (const target of targets) {
    const path = resolveTarget(st, target);
    if (path === null) {
      add(st, 'ask', `${program} 的删除目标无法静态判断：${target.text.slice(0, 80)}`);
      continue;
    }
    const allowed = [...st.ctx.workspaceRoots, ...st.ctx.tmpRoots].some((root) =>
      isInside(path, root),
    );
    if (!allowed) add(st, 'ask', `在工作区之外删除：${path}`);
  }
}

function checkDelete(st: State, program: string, argv: readonly Word[], viaXargs: boolean): void {
  if (viaXargs) {
    add(st, 'ask', `xargs ${program}：删除目标来自管道，无法判断是否在工作区内`);
    return;
  }
  const targets: Word[] = [];
  let optionsEnded = false;
  for (const word of argv.slice(1)) {
    if (!optionsEnded && word.text === '--') optionsEnded = true;
    else if (optionsEnded || !word.text.startsWith('-') || word.dynamic) targets.push(word);
  }
  checkDeletionTargets(st, program, targets);
}

function checkFind(st: State, argv: readonly Word[]): void {
  const args = argv.slice(1);
  const deletes = args.some((w, i) => {
    if (w.text === '-delete') return true;
    if (w.text !== '-exec' && w.text !== '-execdir' && w.text !== '-ok') return false;
    return DELETERS.has(programName(args[i + 1]?.text ?? ''));
  });
  if (!deletes) return;
  const roots: Word[] = [];
  for (const word of args) {
    if (/^[-(!]/.test(word.text)) break;
    roots.push(word);
  }
  checkDeletionTargets(st, 'find', roots.length > 0 ? roots : [{ text: '.', dynamic: false }]);
}

// ---------------------------------------------------------------------------------------------
// Walking a Bash command
// ---------------------------------------------------------------------------------------------

function shellScriptArgument(argv: readonly Word[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]?.text ?? '';
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) return argv[i + 1]?.text ?? null;
    if (!arg.startsWith('-')) return null;
  }
  return null;
}

function checkSimpleCommand(st: State, cmd: SimpleCommand, depth: number): void {
  const eff = effectiveCommand(cmd.words);
  const argv = eff.argv;
  const first = argv[0];
  const program = first ? programName(first.text) : '';
  const args = argv.slice(1).map((w) => w.text);

  for (const nested of eff.nested) checkCommandLine(st, nested, depth + 1);

  if (!TEXT_ONLY.has(program)) {
    for (const word of [...cmd.words, ...cmd.redirects]) {
      const reason = sensitivePath(word.text);
      if (reason) add(st, 'ask', reason);
    }
  }
  if (eff.bareEnv && eff.nested.length === 0) add(st, 'ask', 'env：输出全部环境变量');
  if (!first) return;

  if (program === 'cd' || program === 'pushd') {
    const target = argv[1];
    if (!target) st.cwd = st.ctx.home;
    else if (target.dynamic || target.text === '-') st.cwd = null;
    else {
      const expanded = target.text.replace(/^~(?=\/|$)/, st.ctx.home);
      st.cwd = isAbsolute(expanded) ? resolve(expanded) : st.cwd && resolve(st.cwd, expanded);
    }
    return;
  }

  if (SHELLS.has(program)) {
    const script = shellScriptArgument(argv);
    if (script !== null) checkCommandLine(st, script, depth + 1);
    for (const input of cmd.inputs) checkCommandLine(st, input, depth + 1);
    // A shell that reads its commands from a pipe (no script file, no `-c`), while `codex`
    // appears somewhere on the command line: the piped text may be the program it runs.
    const scriptFile = argv.slice(1).find((w) => !w.text.startsWith('-'));
    if (
      script === null &&
      scriptFile === undefined &&
      cmd.inputs.length === 0 &&
      /codex/i.test(st.raw)
    ) {
      add(st, 'ask', `${program} 从标准输入读命令，且命令行里出现 codex（可能在绕过包装脚本）`);
    }
    // No return: `bash /path/to/codex exec ...` is caught by the argument scan below.
  }
  if (program === 'eval') {
    checkCommandLine(st, args.join(' '), depth + 1);
    return;
  }
  if ((program === 'alias' || program === 'trap') && args.some((a) => /codex/i.test(a))) {
    add(st, 'ask', `${program} 里出现 codex：别名或陷阱可以在钩子看不见的时候启动它`);
  }
  if (INTERPRETERS.has(program) && args.some((a) => /codex/i.test(a))) {
    add(st, 'ask', `${program} 的参数或内联脚本里出现 codex（钩子看不进去）`);
  }

  if (program === 'printenv') add(st, 'ask', 'printenv：输出环境变量');
  if (program === 'export' && args.includes('-p')) add(st, 'ask', 'export -p：输出环境变量');
  if (program === 'gh') checkGh(st, args);
  if (program === 'git') checkGit(st, argv.slice(1));
  if (DELETERS.has(program)) checkDelete(st, program, argv, eff.viaXargs);
  if (program === 'find') checkFind(st, argv);

  if (program === 'codex') {
    checkCodex(st, args, eff.env);
    return;
  }
  // A program given through a variable or substitution cannot be identified; when it is
  // followed by `exec` it may be codex, so the owner decides.
  if (
    first.dynamic &&
    programName(first.text.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, '')) === ''
  ) {
    if (isCodexExec(args)) {
      add(st, 'ask', '无法确定被执行的程序（后面跟着 exec 子命令，可能是 codex exec）');
    }
    for (const input of cmd.inputs) checkCommandLine(st, input, depth + 1);
    return;
  }
  // codex further down the argument list: `perl -e '...' codex exec`, `find -exec codex exec`.
  for (let i = 1; i < argv.length; i++) {
    if (programName(argv[i]?.text ?? '') !== 'codex') continue;
    const rest = argv.slice(i + 1).map((w) => w.text);
    if (isCodexExec(rest)) {
      checkCodex(st, rest, eff.env);
      break;
    }
  }
}

function checkCommandLine(st: State, command: string, depth: number): void {
  if (depth > MAX_DEPTH) {
    add(st, 'ask', '命令嵌套层数过深，无法判断');
    return;
  }
  for (const cmd of splitCommands(command)) {
    for (const sub of cmd.subs) {
      // A substitution runs in a subshell: its `cd` does not leak out.
      const saved = st.cwd;
      checkCommandLine(st, sub, depth + 1);
      st.cwd = saved;
    }
    checkSimpleCommand(st, cmd, depth);
  }
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep']);
const FILE_FIELDS = ['file_path', 'notebook_path', 'path', 'glob'];

export function defaultContext(cwd: string): HookContext {
  return {
    home: '/nonexistent-home',
    workspaceRoots: [cwd],
    tmpRoots: ['/tmp', '/private/tmp'],
    prodHosts: [],
    currentBranch: () => null,
    codexDenyRoots: null,
  };
}

export function decide(input: HookInput, context: Partial<HookContext> = {}): Decision {
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? resolve(input.cwd) : null;
  const ctx: HookContext = { ...defaultContext(cwd ?? '/nonexistent-cwd'), ...context };
  const toolInput =
    typeof input.tool_input === 'object' && input.tool_input !== null
      ? (input.tool_input as Record<string, unknown>)
      : {};
  const raw = typeof toolInput['command'] === 'string' ? toolInput['command'] : '';
  const st: State = { ctx, findings: [], cwd, raw };

  try {
    if (input.tool_name === 'Bash') {
      const command = toolInput['command'];
      if (typeof command === 'string') {
        if (command.includes(DANGEROUS_FLAG)) {
          add(st, 'deny', `命令里出现 ${DANGEROUS_FLAG}（规划/11 §2.4 禁用）`);
        }
        checkCommandLine(st, command, 0);
      }
    } else if (typeof input.tool_name === 'string' && FILE_TOOLS.has(input.tool_name)) {
      for (const field of FILE_FIELDS) {
        const value = toolInput[field];
        const reason = typeof value === 'string' ? sensitivePath(value) : null;
        if (reason) add(st, 'ask', reason);
      }
    }
    if (ctx.prodHosts.length > 0) {
      const haystack = JSON.stringify(toolInput).toLowerCase();
      for (const host of ctx.prodHosts) {
        if (haystack.includes(host.toLowerCase())) add(st, 'ask', `访问生产地址 ${host}`);
      }
    }
  } catch (err) {
    add(st, 'ask', `钩子内部出错，请人工确认：${err instanceof Error ? err.message : String(err)}`);
  }

  const denies = st.findings.filter((f) => f.level === 'deny');
  if (denies.length > 0) {
    return { decision: 'deny', reason: denies.map((f) => f.reason).join('；') };
  }
  if (st.findings.length > 0) {
    return { decision: 'ask', reason: st.findings.map((f) => f.reason).join('；') };
  }
  return { decision: 'allow', reason: '' };
}

/** Hosts listed in prod-hosts.txt (one per line, `#` comments). */
export function parseProdHosts(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '');
}

function realContext(input: HookInput): HookContext {
  const here = dirname(fileURLToPath(import.meta.url));
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
  const project = process.env['CLAUDE_PROJECT_DIR'] || cwd;
  const canonical = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  // The run-state directory of this project (规划/11 §0) counts as part of the workspace when
  // the session works in this repository or in one of its task worktrees.
  const repo = resolve(here, '..', '..', '..');
  const parent = dirname(repo);
  const insideRuns = ['worktrees', 'trusted'].includes(parent.split('/').pop() ?? '');
  const runs = insideRuns ? dirname(parent) : join(parent, 'couli-runs');
  const mainCheckout = insideRuns ? join(dirname(runs), 'rebate-platform') : repo;
  const workspaceRoots = [canonical(project), resolve(project)];
  if ([mainCheckout, runs].some((root) => isInside(canonical(project), canonical(root)))) {
    workspaceRoots.push(canonical(runs), resolve(runs));
  }
  const projectRoots = [
    canonical(mainCheckout),
    resolve(mainCheckout),
    canonical(runs),
    resolve(runs),
  ];
  const hostsFile = join(here, 'prod-hosts.txt');
  return {
    home: homedir(),
    workspaceRoots,
    tmpRoots: [canonical(tmpdir()), resolve(tmpdir()), '/tmp', '/private/tmp'],
    prodHosts: existsSync(hostsFile) ? parseProdHosts(readFileSync(hostsFile, 'utf8')) : [],
    // COULI_HOOK_CODEX_SCOPE=project: deny codex exec only inside this project, ask elsewhere.
    codexDenyRoots: process.env['COULI_HOOK_CODEX_SCOPE'] === 'project' ? projectRoots : null,
    currentBranch: (dir) => {
      try {
        const out = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 3000,
        });
        return out.trim() || null;
      } catch {
        return null;
      }
    },
  };
}

function main(): number {
  let input: HookInput;
  try {
    input = JSON.parse(readFileSync(0, 'utf8')) as HookInput;
  } catch {
    // Not a hook invocation we understand: do not block the session, but say so.
    console.error('couli pretooluse hook: stdin is not JSON; nothing was checked');
    return 0;
  }
  if (typeof input !== 'object' || input === null) return 0;
  const verdict = decide(input, realContext(input));
  const reason = verdict.reason;
  // 规划/11 §8: if "ask" turns out not to prompt in a session, treat it as deny.
  const decision =
    verdict.decision === 'ask' && process.env['COULI_HOOK_ASK_AS_DENY'] === '1'
      ? 'deny'
      : verdict.decision;
  if (decision === 'allow') return 0;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: `[couli 钩子] ${reason}`,
      },
    })}\n`,
  );
  if (decision === 'deny') {
    console.error(`[couli 钩子] 已拒绝：${reason}`);
    return 2;
  }
  return 0;
}

const invoked = process.argv[1];
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
