// Guard runner.
//   run.ts static [--cwd <dir>] [--allow-missing-spec]
//     Checks that need no git history (part of `pnpm verify:fast`, also run in the verify
//     container, which has no .git and no planning repository).
//   run.ts git --base <ref> [--task <id>] [--cwd <dir>]
//     Checks of a diff against <ref>; run on the host by the orchestrator or by CI.
// One summary line per check on stdout, details on stderr, exit 1 when any check failed.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentsPairCheck,
  agentsTableCheck,
  bannedTermsSpecCheck,
  hiddenUnicodeCheck,
  lockfileCheck,
  pathGuardCheck,
  protectedPathsCheck,
  protectedSyncCheck,
  riskMapCoverageCheck,
  schemaLintCheck,
  specRefCheck,
  specRepoRequired,
  testGuardCheck,
  trustedTask,
} from './lib/checks.ts';
import { UsageError, parseArgs, report, resolveRoot, runCli } from './lib/cli.ts';
import type { CheckResult } from './lib/cli.ts';
import { listTreeFiles } from './lib/tree.ts';

function runAll(label: string, checks: [name: string, run: () => CheckResult][]): number {
  let failed = 0;
  let skippedCount = 0;
  for (const [name, run] of checks) {
    let check: CheckResult;
    try {
      check = run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      check = { name, status: 'fail', problems: [`internal error: ${message}`], notices: [] };
    }
    if (report(check) !== 0) failed++;
    if (check.status === 'skip') skippedCount++;
  }
  const passed = checks.length - failed - skippedCount;
  process.stdout.write(`${label}: ${passed} passed, ${failed} failed, ${skippedCount} skipped\n`);
  return failed === 0 ? 0 : 1;
}

function runStatic(argv: string[]): number {
  const args = parseArgs(argv, { values: ['cwd'], flags: ['allow-missing-spec'] });
  if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
  const root = resolveRoot(args.values.get('cwd'));
  if (!existsSync(join(root, '.git'))) {
    console.error(
      `guard: notice: no .git directory at ${root}: files are listed by walking the tree, and ` +
        'checks that need the planning repository are skipped when it is not available',
    );
  }
  const tree = listTreeFiles(root);
  const spec = { requireSpecRepo: specRepoRequired(root, args.flags.has('allow-missing-spec')) };
  return runAll('guard static', [
    ['schema-lint', () => schemaLintCheck(root)],
    ['agents-pair', () => agentsPairCheck(root, tree)],
    ['risk-map-coverage', () => riskMapCoverageCheck(root)],
    ['agents-table', () => agentsTableCheck(root)],
    ['protected-sync', () => protectedSyncCheck(root)],
    ['test-guard', () => testGuardCheck(root, tree)],
    ['hidden-unicode', () => hiddenUnicodeCheck(root, tree)],
    ['lockfile-urls', () => lockfileCheck(root)],
    ['spec-ref', () => specRefCheck(root, spec)],
    ['banned-terms', () => bannedTermsSpecCheck(root, spec)],
  ]);
}

function runGit(argv: string[]): number {
  const args = parseArgs(argv, { values: ['base', 'task', 'cwd'] });
  if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
  const base = args.values.get('base');
  if (base === undefined) throw new UsageError('--base is required');
  const root = resolveRoot(args.values.get('cwd'));
  if (!existsSync(join(root, '.git'))) {
    throw new Error(`${root} is not a git work tree: the git guards run on the host only`);
  }
  const taskId = args.values.get('task');
  const task = taskId === undefined ? null : trustedTask(taskId);
  const checks: [string, () => CheckResult][] = [];
  if (task) {
    checks.push(['path-guard', () => pathGuardCheck(root, base, task.paths, task.type).check]);
  }
  checks.push(
    ['protected-paths', () => protectedPathsCheck(root, base, task?.type).check],
    ['test-guard', () => testGuardCheck(root, listTreeFiles(root), base)],
  );
  return runAll('guard git', checks);
}

runCli(
  'run.ts static [--cwd <dir>] [--allow-missing-spec] | run.ts git --base <ref> [--task <id>] [--cwd <dir>]',
  (argv) => {
    const [mode, ...tail] = argv;
    // `pnpm guard:git -- --base <ref>` forwards the separator as an argument.
    const rest = tail[0] === '--' ? tail.slice(1) : tail;
    if (mode === 'static') return runStatic(rest);
    if (mode === 'git') return runGit(rest);
    throw new UsageError('the first argument must be "static" or "git"');
  },
);
