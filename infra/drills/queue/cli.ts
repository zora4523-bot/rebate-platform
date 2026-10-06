import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  DrillError,
  parseDrillArgs,
  recordPath,
  runDrill,
  type DrillClock,
  type DrillResult,
} from './drill.ts';
import { LocalExecutor, localTarget } from './local.ts';

// System time enters only at the CLI composition root; orchestration uses the injected clock.
const clock: DrillClock = { now: () => new Date() };

/** Resolve existing ancestors as well, so a symlink cannot send reports into the checkout. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), basename(path));
  }
}

async function main(): Promise<void> {
  const args = parseDrillArgs(process.argv.slice(2));
  const target = localTarget();
  const repoRoot = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
  const runsDir = await canonical(resolve(args.runsDir));
  const startedAt = clock.now();
  const path = recordPath({ repoRoot, runsDir, scenario: args.scenario, startedAt });
  // Check the final parent too: drills/queue itself could already be a symlink.
  const parent = await canonical(dirname(path));
  recordPath({ repoRoot, runsDir: parent, scenario: args.scenario, startedAt });
  await mkdir(parent, { recursive: true });
  const destination = join(parent, basename(path));
  // Reserve before any fault, refuse overwrites, and leave a failure record on interrupted runs.
  const file = await open(destination, 'wx', 0o600);
  const executor = new LocalExecutor(target, args.scenario === 'redis-down');
  let interrupted = false;
  const cancel = () => {
    interrupted = true;
    executor.cancel();
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  let result: DrillResult | undefined;
  let firstClockRead = true;
  try {
    await file.writeFile(
      JSON.stringify({
        ok: false,
        status: 'running',
        scenario: args.scenario,
        database: executor.database,
        startedAt: startedAt.toISOString(),
      }) + '\n',
    );
    await file.sync();
    result = await runDrill({
      scenario: args.scenario,
      target,
      executor,
      clock: {
        now: () => {
          if (firstClockRead) {
            firstClockRead = false;
            return startedAt;
          }
          return clock.now();
        },
      },
      sleep,
      newId: randomUUID,
      jobsBefore: args.jobs,
      jobsDuring: args.jobs,
      pollMs: 500,
      progressTimeoutMs: 20_000,
      drainTimeoutMs: Math.max(120_000, args.jobs * 1_000 + 60_000),
    });
    // A successful kill drill must actually exercise redelivery of a committed effect.
    if (args.scenario === 'worker-kill' && result.ok && result.redelivered === 0) {
      result = {
        ...result,
        ok: false,
        problems: [{ code: 'step_failed', id: null, step: 'interrupt' }],
      };
    }
  } finally {
    let cleanupFailed = false;
    try {
      await executor.dispose();
    } catch {
      cleanupFailed = true;
    }
    try {
      if (result !== undefined) {
        if (cleanupFailed || interrupted) {
          result = {
            ...result,
            ok: false,
            problems: [...result.problems, { code: 'step_failed', id: null, step: 'cleanup' }],
          };
        }
        result = { ...result, finishedAt: clock.now().toISOString() };
        const record = {
          ...result,
          database: executor.database,
          consumer: 'isolated-drill-fixture',
        };
        const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, offset);
          if (bytesWritten === 0) throw new Error('Could not write drill record');
          offset += bytesWritten;
        }
        await file.truncate(bytes.length);
        await file.sync();
      }
    } finally {
      await file.close();
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
  }
  process.stdout.write(JSON.stringify({ ok: result?.ok ?? false, record: destination }) + '\n');
  process.exitCode = result?.ok ? 0 : 1;
}

void main().catch((error: unknown) => {
  // Never echo raw database/Docker errors or environment values into an artifact or log.
  const code = error instanceof DrillError ? error.code : 'drill_failed';
  process.stderr.write(JSON.stringify({ ok: false, code }) + '\n');
  process.exitCode = 1;
});
