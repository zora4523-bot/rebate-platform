// Every apps/api/src/modules/* and packages/* directory appears in ops/risk-map.yaml (规划/11 §1.2).
import { riskMapCoverageCheck } from './lib/checks.ts';
import { UsageError, parseArgs, report, resolveRoot, runCli } from './lib/cli.ts';

runCli('risk-map-coverage.ts [--cwd <dir>]', (argv) => {
  const args = parseArgs(argv, { values: ['cwd'] });
  if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
  return report(riskMapCoverageCheck(resolveRoot(args.values.get('cwd'))));
});
