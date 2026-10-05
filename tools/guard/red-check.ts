// Red check (规划/11 §2.3 step 3), see lib/red-check.ts:
//
//   node tools/guard/red-check.ts --task <id> --report <json>[,<json>…]
//     (--expected-list <file> | --cwd <worktree> --base <ref>) [--root <dir>] [--json]
//
// The expected rule-test files come from a list (one repository path per line; written by
// tools/ops/verify-container.sh --red) or from the worktree's changes against the base, inside the
// task's test_paths (trusted ledger). A task without a rule-test author (tester: none) is skipped.
// --json: stdout is exactly one JSON document; everything else goes to stderr (CR-16).
//
//   node tools/guard/red-check.ts --task <id> --cwd <worktree> --base <ref> --print-expected
//     prints the expected rule-test files, one per line (tools/ops/verify-container.sh --red uses
//     it to pick what to run, and later checks the report against the same list).
import { readFileSync } from 'node:fs';
import { changedFiles } from '../lib/git.ts';
import { trustedRoot } from '../lib/paths.ts';
import { loadTask } from '../lib/task-file.ts';
import { UsageError, parseArgs, printJson, resolveRoot, runCli } from './lib/cli.ts';
import { checkRedReports, expectedRuleTests, redCheckRequired } from './lib/red-check.ts';

runCli(
  'red-check.ts --task <id> --report <json>[,<json>] (--expected-list <file> | --cwd <dir> --base <ref>) [--root <dir>] [--json]',
  (argv) => {
    const args = parseArgs(argv, {
      values: ['task', 'report', 'root', 'expected-list', 'cwd', 'base'],
      flags: ['json', 'print-expected'],
    });
    if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
    const json = args.flags.has('json');
    const say = (line: string): void => {
      if (json) console.error(line);
      else console.log(line);
    };
    const id = args.values.get('task');
    const reportArg = args.values.get('report');
    const printExpected = args.flags.has('print-expected');
    if (id === undefined || (reportArg === undefined && !printExpected)) {
      throw new UsageError('--task and --report are required');
    }
    const task = loadTask(id, trustedRoot());
    if (printExpected) {
      const base = args.values.get('base');
      if (base === undefined)
        throw new UsageError('--print-expected needs --cwd <dir> --base <ref>');
      const files = expectedRuleTests(
        changedFiles(base, { cwd: resolveRoot(args.values.get('cwd')) }),
        task.test_paths,
      );
      for (const file of files) console.log(file);
      return 0;
    }
    if (reportArg === undefined) throw new UsageError('--report is required');
    if (!redCheckRequired(task)) {
      if (json) printJson({ task: id, required: false, ok: true, red: [], problems: [] });
      say(`SKIP red-check: task ${id} has no rule-test author (tester: none)`);
      return 0;
    }
    let expected: string[];
    const list = args.values.get('expected-list');
    const base = args.values.get('base');
    if (list !== undefined) {
      expected = readFileSync(list, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
    } else if (base !== undefined) {
      expected = expectedRuleTests(
        changedFiles(base, { cwd: resolveRoot(args.values.get('cwd')) }),
        task.test_paths,
      );
    } else {
      throw new UsageError('give --expected-list <file> or --cwd <dir> --base <ref>');
    }
    const reports = reportArg.split(',').map((file) => {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as unknown;
      } catch (err) {
        throw new Error(
          `cannot read the report ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    // The verify container reports files under /work/repo.
    const result = checkRedReports(reports, expected, args.values.get('root') ?? '/work/repo');
    for (const p of result.problems) {
      console.error(`red-check: ${p.file}${p.test === null ? '' : ` > ${p.test}`}: ${p.reason}`);
    }
    if (json) printJson({ task: id, required: true, expected, ...result });
    say(
      result.ok
        ? `PASS red-check: ${result.red.length} rule test(s) in ${expected.length} file(s) red for the right reason`
        : `FAIL red-check: ${result.problems.length} problem(s)`,
    );
    return result.ok ? 0 : 1;
  },
);
