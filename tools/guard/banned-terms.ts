// Banned terms (规划/11 §5.5): `--spec` scans 规划/** at SPEC_REF, `--file` scans task briefs.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bannedTermsFilesCheck, bannedTermsSpecCheck, specRepoRequired } from './lib/checks.ts';
import { UsageError, parseArgs, report, resolveRoot, runCli } from './lib/cli.ts';

runCli(
  'banned-terms.ts (--spec [--cwd <dir>] [--allow-missing-spec] | --file <path>...)',
  (argv) => {
    const args = parseArgs(argv, {
      values: ['cwd'],
      flags: ['spec', 'file', 'allow-missing-spec'],
    });
    const spec = args.flags.has('spec');
    const file = args.flags.has('file');
    if (spec === file) throw new UsageError('give exactly one of --spec and --file');
    if (file) {
      if (args.rest.length === 0) throw new UsageError('--file needs at least one path');
      return report(bannedTermsFilesCheck(args.rest));
    }
    if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
    const root = resolveRoot(args.values.get('cwd'));
    if (!existsSync(join(root, '.git'))) {
      console.error(`banned-terms: notice: no .git directory at ${root}`);
    }
    return report(
      bannedTermsSpecCheck(root, {
        requireSpecRepo: specRepoRequired(root, args.flags.has('allow-missing-spec')),
      }),
    );
  },
);
