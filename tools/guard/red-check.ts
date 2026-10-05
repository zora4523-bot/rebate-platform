// Red check (规划/11 §2.3 step 3): node tools/guard/red-check.ts --task <id> --report <json>
// [--root <dir>] [--json]. See lib/red-check.ts. Task and rule-test locations come from the
// trusted root. A task without a rule-test author (tester: none) is skipped (exit 0, SKIP).
import { readFileSync } from 'node:fs';
import { trustedRoot } from '../lib/paths.ts';
import { loadTask } from '../lib/task-file.ts';
import { UsageError, parseArgs, printJson, runCli } from './lib/cli.ts';
import { loadProtected, splitFragment } from './lib/protected.ts';
import { checkRedReport, redCheckRequired } from './lib/red-check.ts';

runCli('red-check.ts --task <id> --report <vitest-json> [--root <dir>] [--json]', (argv) => {
  const args = parseArgs(argv, { values: ['task', 'report', 'root'], flags: ['json'] });
  if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
  const id = args.values.get('task');
  const reportFile = args.values.get('report');
  if (id === undefined || reportFile === undefined) {
    throw new UsageError('--task and --report are required');
  }
  const task = loadTask(id, trustedRoot());
  if (!redCheckRequired(task)) {
    if (args.flags.has('json'))
      printJson({ task: id, required: false, ok: true, red: [], problems: [] });
    console.log(`SKIP red-check: task ${id} has no rule-test author (tester: none)`);
    return 0;
  }
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(reportFile, 'utf8'));
  } catch (err) {
    throw new Error(
      `cannot read the report ${reportFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const globs = loadProtected(trustedRoot()).class1_add_only.map((g) => splitFragment(g).glob);
  // The verify container reports files under /work/repo; a host run under the worktree.
  const root = args.values.get('root') ?? '/work/repo';
  const result = checkRedReport(report, globs, root);
  for (const p of result.problems) {
    console.error(`red-check: ${p.file}${p.test === null ? '' : ` > ${p.test}`}: ${p.reason}`);
  }
  if (args.flags.has('json')) printJson({ task: id, required: true, ...result });
  else
    console.log(
      result.ok
        ? `PASS red-check: ${result.red.length} rule test(s) red for the right reason`
        : `FAIL red-check: ${result.problems.length} problem(s)`,
    );
  return result.ok ? 0 : 1;
});
