// Protected paths (规划/11 §4.4). Exit 1 when the diff touches any protected path; the caller
// turns class 2 / 3 hits into `ask` (owner approval) and class 1 hits into a failed task.
import { TASK_TYPES } from '../lib/task-file.ts';
import { protectedPathsCheck } from './lib/checks.ts';
import { UsageError, parseArgs, printJson, report, resolveRoot, runCli } from './lib/cli.ts';

runCli(
  'protected-paths.ts --base <ref> [--cwd <worktree>] [--task-type <type>] [--json]',
  (argv) => {
    const args = parseArgs(argv, { values: ['base', 'cwd', 'task-type'], flags: ['json'] });
    if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
    const base = args.values.get('base');
    if (base === undefined) throw new UsageError('--base is required');
    const taskType = args.values.get('task-type');
    if (taskType !== undefined && !(TASK_TYPES as readonly string[]).includes(taskType)) {
      throw new UsageError(`--task-type must be one of ${TASK_TYPES.join(', ')}`);
    }
    const outcome = protectedPathsCheck(resolveRoot(args.values.get('cwd')), base, taskType);
    if (args.flags.has('json')) {
      for (const problem of outcome.check.problems) console.error(`protected-paths: ${problem}`);
      const byClass = (cls: number): string[] =>
        outcome.hits.filter((h) => h.class === cls).map((h) => h.path);
      printJson({
        ok: outcome.hits.length === 0,
        hits: outcome.hits,
        class1: byClass(1),
        class2: byClass(2),
        class3: byClass(3),
      });
      return outcome.hits.length === 0 ? 0 : 1;
    }
    return report(outcome.check);
  },
);
