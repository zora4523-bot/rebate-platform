// Path guard (规划/11 §2.3 step 6): run before anything from the worktree is executed.
// --author: the guard of a rule-test run (Codex writing the rule tests, 规划/11 §2.3 step 3):
// only rule-test assets and NotImplemented skeleton shells inside the task paths
// (lib/spec-base.ts checkAuthorPaths; ops/approvals.yaml id 19).
import { splitTopLevelCommas } from '../lib/glob.ts';
import { authorWorktreeCheck, pathGuardCheck, trustedTask } from './lib/checks.ts';
import { UsageError, parseArgs, printJson, report, resolveRoot, runCli } from './lib/cli.ts';

runCli(
  'path-guard.ts (--task <id> | --paths <glob,glob>) --base <ref> [--author] [--cwd <worktree>] [--json]',
  (argv) => {
    const args = parseArgs(argv, {
      values: ['task', 'paths', 'base', 'cwd'],
      flags: ['json', 'author'],
    });
    if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
    const taskId = args.values.get('task');
    const pathList = args.values.get('paths');
    const base = args.values.get('base');
    if ((taskId === undefined) === (pathList === undefined)) {
      throw new UsageError('give exactly one of --task and --paths');
    }
    if (base === undefined) throw new UsageError('--base is required');

    let allowed: string[];
    let taskType: string | undefined;
    if (taskId !== undefined) {
      const task = trustedTask(taskId);
      allowed = task.paths;
      taskType = task.type;
    } else {
      allowed = splitTopLevelCommas(pathList ?? '')
        .map((g) => g.trim())
        .filter((g) => g !== '');
      if (allowed.length === 0) throw new UsageError('--paths is empty');
    }

    const root = resolveRoot(args.values.get('cwd'));
    const outcome = args.flags.has('author')
      ? authorWorktreeCheck(root, base, allowed, taskType)
      : pathGuardCheck(root, base, allowed, taskType);
    if (args.flags.has('json')) {
      for (const problem of outcome.check.problems) console.error(`path-guard: ${problem}`);
      printJson(outcome.detail);
      return outcome.detail.ok ? 0 : 1;
    }
    return report(outcome.check);
  },
);
