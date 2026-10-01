// Risk level and protected class of paths (规划/11 §1.2). Inputs are changed files or task globs.
// Always exits 0 unless the usage is wrong; data comes from the trusted root.
import { readFileSync } from 'node:fs';
import { trustedRoot } from '../lib/paths.ts';
import { UsageError, parseArgs, printJson, runCli } from './lib/cli.ts';
import { loadProtected } from './lib/protected.ts';
import { loadRiskMap, riskOfPaths } from './lib/risk.ts';

runCli('risk-of-paths.ts [--json] [--stdin | <path>...]', (argv) => {
  const args = parseArgs(argv, { flags: ['json', 'stdin'] });
  let inputs = args.rest;
  if (args.flags.has('stdin')) {
    if (inputs.length > 0) throw new UsageError('--stdin cannot be combined with path arguments');
    const text = readFileSync(0, 'utf8');
    inputs = text
      .split(text.includes('\0') ? '\0' : '\n')
      .map((p) => p.replace(/\r$/, ''))
      .filter((p) => p !== '');
  } else if (inputs.length === 0) {
    throw new UsageError('give at least one path, or --stdin');
  }
  const root = trustedRoot();
  const report = riskOfPaths(inputs, loadRiskMap(root), loadProtected(root));
  if (args.flags.has('json')) {
    printJson(report);
  } else {
    for (const p of report.paths) {
      const prot = p.protected === null ? '' : `  protected class ${p.protected}`;
      process.stdout.write(`${p.risk}  ${p.path}  (${p.rule})${prot}\n`);
    }
    process.stdout.write(
      `risk: ${report.risk}${report.ask ? '  ask: owner approval needed' : ''}\n`,
    );
  }
  return 0;
});
