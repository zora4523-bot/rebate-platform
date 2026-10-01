// Keeps the 分工 table of the root AGENTS.md in sync with ops/risk-map.yaml (规划/11 §1.2).
// `--write` edits AGENTS.md (a protected path, class 3): run it only in a task that is allowed to.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/fsx.ts';
import { renderRiskTable, replaceTable } from './lib/agents-table.ts';
import { agentsTableCheck } from './lib/checks.ts';
import { UsageError, parseArgs, report, resolveRoot, runCli } from './lib/cli.ts';
import { loadRiskMap } from './lib/risk.ts';

runCli('agents-table.ts (--write | --check) [--cwd <dir>]', (argv) => {
  const args = parseArgs(argv, { values: ['cwd'], flags: ['write', 'check'] });
  if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
  if (args.flags.has('write') === args.flags.has('check')) {
    throw new UsageError('give exactly one of --write and --check');
  }
  const root = resolveRoot(args.values.get('cwd'));
  if (args.flags.has('check')) return report(agentsTableCheck(root));

  const file = join(root, 'AGENTS.md');
  if (!existsSync(file)) throw new Error(`${file} does not exist`);
  const before = readFileSync(file, 'utf8');
  const after = replaceTable(before, renderRiskTable(loadRiskMap(root)));
  if (after === before) {
    console.error('agents-table: AGENTS.md is already up to date');
  } else {
    writeFileAtomic(file, after);
    console.error('agents-table: AGENTS.md updated');
  }
  return 0;
});
