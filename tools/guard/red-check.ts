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
// With --base (and --cwd), the expected files that existed at the base need only their new and
// changed tests red (CT-06p, lib/red-check.ts): their base content is read from the base, the head
// content from --head-tree <tree> (the snapshot the red run ran; verify-container.sh --red passes
// it) or else from the work tree. Without --base, or when the comparison cannot be made, every
// test of every expected file must be red, as before (the reason is in the notes). The trusted
// ledger's `red_exempt` declarations (CT-06r) are handed to the check with the baselines: an
// unchanged test of a file judged as a whole only because it may read a changed test-support
// file may be declared exempt (lib/red-check.ts); the notes say which and that the rule-test
// reviewer must confirm them.
//
//   node tools/guard/red-check.ts --task <id> --cwd <worktree> --base <ref> --print-expected
//     prints the expected rule-test files, one per line (tools/ops/verify-container.sh --red uses
//     it to pick what to run, and later checks the report against the same list).
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { type Change, changedBetweenCommits, changedFiles, tryGit } from '../lib/git.ts';
import { trustedRoot } from '../lib/paths.ts';
import { loadLegacyTasks, ruleTestScope } from '../lib/legacy-tasks.ts';
import { loadTask } from '../lib/task-file.ts';
import { ruleTestAssets } from './lib/checks.ts';
import type { PathKind } from './lib/test-blocks.ts';
import { UsageError, parseArgs, printJson, resolveRoot, runCli } from './lib/cli.ts';
import {
  type RuleTestBaseline,
  checkRedReports,
  expectedRuleTests,
  redCheckRequired,
  ruleTestBaselines,
} from './lib/red-check.ts';

/** `<ref>:<path>` in the repository at `cwd`, or null when it does not exist. */
function showAt(cwd: string, ref: string, path: string): string | null {
  const res = tryGit(['show', `${ref}:${path}`], { cwd });
  return res.status === 0 ? res.stdout : null;
}

function readWorkTree(cwd: string, path: string): string | null {
  try {
    return readFileSync(join(cwd, path), 'utf8');
  } catch {
    return null;
  }
}

/**
 * What `<ref>:<path>` is in the tree (CT-06w, Codex reviews r1, r2): a blob of mode 100644 / 100755
 * is a file, a tree a directory, nothing absent; a symbolic link, a submodule, a quoted (non-ASCII)
 * path or a failed query is `other` — not certain, so an import never resolves through it.
 */
function kindAt(cwd: string, ref: string, path: string): PathKind {
  const res = tryGit(['ls-tree', ref, '--', path], { cwd });
  if (res.status !== 0) return 'other';
  const line = res.stdout.split('\n')[0] ?? '';
  if (line === '') return 'absent';
  if (!line.endsWith(`\t${path}`)) return 'other';
  if (/^(100644|100755) blob /.test(line)) return 'file';
  if (/^040000 tree /.test(line)) return 'dir';
  return 'other';
}

/**
 * What a path is in the work tree at `cwd`: a regular file or a directory whose canonical path
 * (realpath: no symbolic link in any component, the tree's own case) is the path itself; a
 * symbolic link, a path through one, a case alias or anything else is `other` (Codex review r2).
 */
function kindInWorkTree(cwd: string, path: string): PathKind {
  const abs = join(cwd, path);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(abs);
  } catch {
    return 'absent';
  }
  if (stat.isSymbolicLink()) return 'other';
  try {
    if (realpathSync.native(abs) !== join(realpathSync.native(cwd), path)) return 'other';
  } catch {
    return 'other';
  }
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'dir';
  return 'other';
}

runCli(
  'red-check.ts --task <id> --report <json>[,<json>] (--expected-list <file> | --cwd <dir> --base <ref>) [--cwd <dir> --base <ref> [--head-tree <tree>]] [--root <dir>] [--json]',
  (argv) => {
    const args = parseArgs(argv, {
      values: ['task', 'report', 'root', 'expected-list', 'cwd', 'base', 'head-tree'],
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
    // The same scope as the path guards (CR3-01): test_paths, or the old scope of a legacy ledger.
    const scope = ruleTestScope(task, loadLegacyTasks(trustedRoot()), ruleTestAssets());
    if (printExpected) {
      const base = args.values.get('base');
      if (base === undefined)
        throw new UsageError('--print-expected needs --cwd <dir> --base <ref>');
      const files = expectedRuleTests(
        changedFiles(base, { cwd: resolveRoot(args.values.get('cwd')) }),
        scope,
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
    const headTree = args.values.get('head-tree');
    if (headTree !== undefined && base === undefined) {
      throw new UsageError('--head-tree needs --cwd <dir> --base <ref>');
    }
    const cwd = resolveRoot(args.values.get('cwd'));
    if (list !== undefined) {
      expected = readFileSync(list, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
    } else if (base !== undefined) {
      expected = expectedRuleTests(changedFiles(base, { cwd }), scope);
    } else {
      throw new UsageError('give --expected-list <file> or --cwd <dir> --base <ref>');
    }
    // CT-06p: which expected files existed at the base, and which of their tests changed.
    let baselines: Map<string, RuleTestBaseline> | undefined;
    let baselineNote: string | null = null;
    if (base !== undefined) {
      try {
        const changes: Change[] =
          headTree === undefined
            ? changedFiles(base, { cwd })
            : changedBetweenCommits(base, headTree, { cwd });
        baselines = ruleTestBaselines(expected, changes, scope, {
          base: (p) => showAt(cwd, base, p),
          head: (p) => (headTree === undefined ? readWorkTree(cwd, p) : showAt(cwd, headTree, p)),
          headKind: (p) =>
            headTree === undefined ? kindInWorkTree(cwd, p) : kindAt(cwd, headTree, p),
        });
      } catch (err) {
        baselines = undefined;
        baselineNote = `cannot compare with the base ${base} (${err instanceof Error ? err.message : String(err)}): every test of every expected file must be red`;
      }
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
    const result = checkRedReports(
      reports,
      expected,
      args.values.get('root') ?? '/work/repo',
      baselines,
      task.red_exempt,
    );
    if (baselineNote !== null) result.notes.unshift(baselineNote);
    for (const p of result.problems) {
      console.error(`red-check: ${p.file}${p.test === null ? '' : ` > ${p.test}`}: ${p.reason}`);
    }
    for (const n of result.notes) console.error(`red-check note: ${n}`);
    if (json) printJson({ task: id, required: true, expected, ...result });
    const exempt = result.exempt?.length ?? 0;
    const declared = result.exempt?.filter((e) => e.declared === true).length ?? 0;
    say(
      result.ok
        ? `PASS red-check: ${result.red.length} rule test(s) in ${expected.length} file(s) red for the right reason` +
            (exempt > 0
              ? `; ${exempt} unchanged test(s) of files that existed at the base exempt`
              : '') +
            (declared > 0
              ? ` (${declared} by the ledger's red_exempt declarations: the rule-test reviewer must confirm them)`
              : '')
        : `FAIL red-check: ${result.problems.length} problem(s)`,
    );
    return result.ok ? 0 : 1;
  },
);
