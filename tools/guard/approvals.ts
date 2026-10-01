// Owner approvals (规划/11 §3.2, §7.3). Exit 0 only when the entry is `granted: true` in
// ops/approvals.yaml of the trusted root; statements anywhere else do not count (§5.2).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trustedRoot } from '../lib/paths.ts';
import { findApproval, parseApprovals } from './lib/approvals.ts';
import { UsageError, parseArgs, printJson, runCli } from './lib/cli.ts';

runCli('approvals.ts --require <id> [--json]', (argv) => {
  const args = parseArgs(argv, { values: ['require'], flags: ['json'] });
  if (args.rest.length > 0) throw new UsageError(`unexpected argument "${args.rest[0]}"`);
  const raw = args.values.get('require');
  if (raw === undefined || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new UsageError('--require needs the numeric id of a row in 规划/11 §7.3');
  }
  const id = Number(raw);
  const file = join(trustedRoot(), 'ops', 'approvals.yaml');
  if (!existsSync(file)) {
    console.error(`approvals: ${file} does not exist: nothing is approved`);
    if (args.flags.has('json')) printJson({ id, granted: false, approval: null });
    return 1;
  }
  const approval = findApproval(parseApprovals(readFileSync(file, 'utf8')), id);
  const granted = approval?.granted === true;
  if (args.flags.has('json')) printJson({ id, granted, approval });
  if (granted) {
    console.error(`approvals: #${id} granted on ${approval.date}: ${approval.title}`);
    return 0;
  }
  console.error(
    approval === null
      ? `approvals: #${id} is not listed in ops/approvals.yaml`
      : `approvals: #${id} is not granted: ${approval.title}`,
  );
  return 1;
});
