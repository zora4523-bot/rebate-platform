// Test guard: static rules for test files, vitest configs and package scripts
// (规划/11 §2.3 step 5, §4.1–§4.3); with --base also the add-only rule of §4.4 class 1.
import { testGuardCheck } from './lib/checks.ts';
import { UsageError, parseArgs, printJson, report, resolveRoot, runCli } from './lib/cli.ts';
import { listTreeFiles } from './lib/tree.ts';

runCli('test-guard.ts [--base <ref>] [--cwd <dir>] [--json]', (argv) => {
  const args = parseArgs(argv, { values: ['base', 'cwd'], flags: ['json'] });
  if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
  const root = resolveRoot(args.values.get('cwd'));
  const check = testGuardCheck(root, listTreeFiles(root), args.values.get('base'));
  if (args.flags.has('json')) {
    for (const problem of check.problems) console.error(`test-guard: ${problem}`);
    printJson({
      ok: check.status === 'pass',
      findings: check.findings,
      add_only_violations: check.add_only_violations,
    });
    return check.status === 'pass' ? 0 : 1;
  }
  return report(check);
});
