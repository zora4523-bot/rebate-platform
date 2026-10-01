// protected-paths.json and the copy embedded in the CI workflow must be identical (规划/11 §4.4).
import { protectedSyncCheck } from './lib/checks.ts';
import { UsageError, parseArgs, report, resolveRoot, runCli } from './lib/cli.ts';

runCli('protected-sync.ts [--cwd <dir>]', (argv) => {
  const args = parseArgs(argv, { values: ['cwd'] });
  if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
  return report(protectedSyncCheck(resolveRoot(args.values.get('cwd'))));
});
