// Lints agent output schemas (规划/11 §2.4 "schema 写法"). Without arguments it checks
// tools/agent/schemas/*.json of the inspected tree.
import { schemaLintCheck } from './lib/checks.ts';
import { parseArgs, report, resolveRoot, runCli } from './lib/cli.ts';

runCli('schema-lint.ts [--cwd <dir>] [file...]', (argv) => {
  const args = parseArgs(argv, { values: ['cwd'] });
  return report(schemaLintCheck(resolveRoot(args.values.get('cwd')), args.rest));
});
