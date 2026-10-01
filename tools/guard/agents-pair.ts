// AGENTS.md / CLAUDE.md pairing and line caps (规划/11 §5.1, §5.5).
import { agentsPairCheck } from './lib/checks.ts';
import { UsageError, parseArgs, report, resolveRoot, runCli } from './lib/cli.ts';
import { listTreeFiles } from './lib/tree.ts';

runCli('agents-pair.ts [--cwd <dir>]', (argv) => {
  const args = parseArgs(argv, { values: ['cwd'] });
  if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
  const root = resolveRoot(args.values.get('cwd'));
  return report(agentsPairCheck(root, listTreeFiles(root)));
});
