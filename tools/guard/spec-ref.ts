// SPEC_REF is a commit on the planning repository's main branch (规划/11 §5.3).
import { specRefCheck, specRepoRequired } from './lib/checks.ts';
import { UsageError, parseArgs, report, resolveRoot, runCli } from './lib/cli.ts';

runCli('spec-ref.ts [--cwd <dir>] [--allow-missing-spec]', (argv) => {
  const args = parseArgs(argv, { values: ['cwd'], flags: ['allow-missing-spec'] });
  if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
  const root = resolveRoot(args.values.get('cwd'));
  return report(
    specRefCheck(root, {
      requireSpecRepo: specRepoRequired(root, args.flags.has('allow-missing-spec')),
    }),
  );
});
