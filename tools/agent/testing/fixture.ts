// Test fixtures for tools/agent: a throwaway git repository with a linked task worktree, a
// run-state directory and a trusted root with stub CLIs, all under REPO/.tmp/ (git-ignored,
// outside /tmp and $TMPDIR). Nothing here touches the real couli-runs directory or the real
// codex binary.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TOOLS_DIR = resolve(AGENT_DIR, '..');
export const REPO = resolve(TOOLS_DIR, '..');
export const FAKE_CODEX = join(AGENT_DIR, 'testing', 'couli-fake-codex.sh');
export const TASK = 'T1-01';

export type Fixture = {
  root: string;
  runs: string;
  run: string;
  main: string;
  worktree: string;
  trusted: string;
  log: string;
  baseSha: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
};

/** Environment for child processes: hermetic git, no inherited Codex or COULI settings. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('COULI_') || key.startsWith('FAKE_') || key.startsWith('GIT_')) continue;
    if (key === 'CODEX_HOME') continue;
    env[key] = value;
  }
  env['GIT_CONFIG_GLOBAL'] = '/dev/null';
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  return env;
}

export function gitIn(dir: string, args: readonly string[]): string {
  const res = spawnSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8', env: baseEnv() },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/**
 * One behaviour of a stub CLI: the first rule whose `when` tokens all occur in the arguments
 * wins. `writeOut` writes that text to the file named after `--out`.
 */
export type StubRule = {
  when?: string[];
  exit?: number;
  stdout?: string;
  stderr?: string;
  writeOut?: string;
};

/**
 * Writes a stub for another package's CLI. Every call appends `[name, ...argv]` as one JSON
 * line to `<FAKE_OPS_LOG>/calls.log`, so tests can assert the order of calls across stubs.
 */
export function writeStub(file: string, name: string, rules: StubRule[] = []): void {
  mkdirSync(dirname(file), { recursive: true });
  const source = [
    "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const dir = process.env['FAKE_OPS_LOG'] ?? '';",
    'const args = process.argv.slice(2);',
    "if (dir !== '') {",
    '  mkdirSync(dir, { recursive: true });',
    `  appendFileSync(join(dir, 'calls.log'), JSON.stringify([${JSON.stringify(name)}, ...args]) + '\\n');`,
    '}',
    `const rules = ${JSON.stringify(rules)};`,
    'const rule = rules.find((r) => (r.when ?? []).every((token) => args.includes(token))) ?? {};',
    "if (rule.writeOut !== undefined) writeFileSync(args[args.indexOf('--out') + 1], rule.writeOut);",
    "if (rule.stdout !== undefined) process.stdout.write(rule.stdout + '\\n');",
    "if (rule.stderr !== undefined) process.stderr.write(rule.stderr + '\\n');",
    'process.exitCode = rule.exit ?? 0;',
    '',
  ].join('\n');
  writeFileSync(file, source);
}

/**
 * Builds the fixture tree:
 *   <root>/main                      git repository (branch main, one commit)
 *   <root>/runs/worktrees/T1-01      linked worktree on branch task/T1-01
 *   <root>/runs/T1-01/brief.md       task brief
 *   <root>/trusted                   copy of tools/agent + tools/lib, stub tools/ops/usage.ts
 *                                    (token accounting only; nothing gates on it)
 */
export function makeFixture(name: string): Fixture {
  const root = join(REPO, '.tmp', `agent-${name}-${process.pid}-${randomBytes(4).toString('hex')}`);
  mkdirSync(root, { recursive: true });
  const real = realpathSync(root);
  const main = join(real, 'main');
  const runs = join(real, 'runs');
  const run = join(runs, TASK);
  const worktree = join(runs, 'worktrees', TASK);
  const trusted = join(real, 'trusted');
  const log = join(real, 'log');

  mkdirSync(join(main, 'src'), { recursive: true });
  writeFileSync(join(main, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(main, 'README.md'), '# fixture\n');
  const init = spawnSync('git', ['init', '-q', '-b', 'main', main], { env: baseEnv() });
  if (init.status !== 0) throw new Error('git init failed');
  gitIn(main, ['add', '.']);
  gitIn(main, ['commit', '-q', '-m', 'init']);
  const baseSha = gitIn(main, ['rev-parse', 'HEAD']);
  mkdirSync(join(runs, 'worktrees'), { recursive: true });
  gitIn(main, ['worktree', 'add', '-q', '-b', `task/${TASK}`, worktree]);

  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'brief.md'), `# 任务 ${TASK}：fixture task\n\nDo not commit.\n\n`);

  mkdirSync(join(trusted, 'tools'), { recursive: true });
  cpSync(AGENT_DIR, join(trusted, 'tools', 'agent'), { recursive: true });
  cpSync(join(TOOLS_DIR, 'lib'), join(trusted, 'tools', 'lib'), { recursive: true });
  symlinkSync(join(TOOLS_DIR, 'node_modules'), join(trusted, 'tools', 'node_modules'));
  writeStub(join(trusted, 'tools', 'ops', 'usage.ts'), 'usage');

  const env = baseEnv();
  env['COULI_RUNS'] = runs;
  env['COULI_TRUSTED_ROOT'] = trusted;
  // The fake codex is accepted only with the explicit test switch and a runs directory under
  // a `.tmp` directory (see resolve_codex_bin in codex-run.sh).
  env['COULI_AGENT_TEST'] = '1';
  env['COULI_CODEX_BIN'] = FAKE_CODEX;
  env['COULI_KILL_GRACE_SECS'] = '1';
  env['FAKE_CODEX_LOG'] = log;
  env['FAKE_OPS_LOG'] = log;

  return {
    root: real,
    runs,
    run,
    main,
    worktree,
    trusted,
    log,
    baseSha,
    env,
    cleanup: () => rmSync(real, { recursive: true, force: true }),
  };
}

export type RunResult = { status: number | null; stdout: string; stderr: string };

export function runScript(
  script: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  extraEnv: Record<string, string> = {},
): RunResult {
  const res: SpawnSyncReturns<string> = spawnSync('bash', [join(AGENT_DIR, script), ...args], {
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** argv the fake codex was started with (it logs it NUL-separated). */
export function observedArgv(fx: Fixture): string[] {
  const raw = readFileSync(join(fx.log, 'argv.nul'), 'utf8');
  return raw.split('\0').slice(0, -1);
}

/** key=value facts logged by the fake codex. */
export function observed(fx: Fixture): Record<string, string> {
  const file = join(fx.log, 'observed.txt');
  const facts: Record<string, string> = {};
  if (!existsSync(file)) return facts;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) facts[line.slice(0, at)] = line.slice(at + 1);
  }
  return facts;
}

/** Calls received by the stub CLIs, in order: `[stub name, ...argv]`. */
export function stubCalls(fx: Fixture, name?: string): string[][] {
  const file = join(fx.log, 'calls.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as string[])
    .filter((call) => name === undefined || call[0] === name);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
