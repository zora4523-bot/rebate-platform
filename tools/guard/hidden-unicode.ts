// Fails on bidirectional controls and zero-width characters in text files (规划/11 §4.1).
import { hiddenUnicodeCheck } from './lib/checks.ts';
import { UsageError, parseArgs, report, resolveRoot, runCli } from './lib/cli.ts';
import { listTreeFiles } from './lib/tree.ts';

runCli('hidden-unicode.ts [--cwd <dir>]', (argv) => {
  const args = parseArgs(argv, { values: ['cwd'] });
  if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
  const root = resolveRoot(args.values.get('cwd'));
  const tree = listTreeFiles(root);
  if (tree.mode === 'walk') {
    console.error(`hidden-unicode: notice: no .git directory at ${root}; walking the tree instead`);
  }
  return report(hiddenUnicodeCheck(root, tree));
});
