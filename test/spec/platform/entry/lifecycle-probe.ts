// Loaded only by the B1-01zl integration children. Never installs signal handlers or a timer.
// IPC checkpoints let the parent observe a responsive event loop without a fixed sleep.
// Unref the channel so it cannot hide a missing payout keep-alive or prevent natural exit.
import { writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { QueueRuntime } from '../../../../apps/api/src/modules/platform/queue/types.ts';

let queue: QueueRuntime | undefined;

// Pause INSIDE createHttpApp/createWorkerContext, before Nest creates the real application.
// This only delays the original factory; no fake app, signal handler or shutdown is supplied.
// Resolve Nest from the API workspace, so the entry and probe use the same factory instance.
if (process.env['ENTRY_PROBE_HOLD_FACTORY'] === '1' || process.env['ENTRY_PROBE_QUEUE'] === '1') {
  interface Context {
    get<T>(token: symbol): T;
  }
  type Factory = (...args: unknown[]) => Promise<Context>;
  const requireApi = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const { NestFactory } = (await import(
    pathToFileURL(requireApi.resolve('@nestjs/core')).href
  )) as {
    NestFactory: Record<'create' | 'createApplicationContext', Factory>;
  };
  for (const method of ['create', 'createApplicationContext'] as const) {
    const original = NestFactory[method];
    NestFactory[method] = async function (...args: unknown[]): Promise<Context> {
      if (process.env['ENTRY_PROBE_HOLD_FACTORY'] === '1') {
        // Only the explicit startup barrier refs IPC; normal idle-lifetime checks stay unrefed.
        process.channel?.ref();
        await new Promise<void>((resolve) => {
          const release = (message: unknown): void => {
            if (message !== 'release-factory') return;
            process.off('message', release);
            process.channel?.unref();
            resolve();
          };
          process.on('message', release);
          process.send?.('factory-waiting');
        });
      }
      const context = await original.apply(NestFactory, args);
      if (process.env['ENTRY_PROBE_QUEUE'] === '1') {
        const platformUrl = new URL(
          '../../../../apps/api/dist/modules/platform/index.js',
          import.meta.url,
        );
        const { JOB_QUEUE } = (await import(platformUrl.href)) as { JOB_QUEUE: symbol };
        queue = context.get<QueueRuntime>(JOB_QUEUE);
      }
      return context;
    };
  }
}

async function checkQueue(): Promise<void> {
  try {
    // Only the isolated test database: a delayed inert job, no business handler is installed.
    const id = await queue?.send(
      'notify',
      'entry_lifecycle.probe',
      {},
      {
        trx: null,
        delaySeconds: 3600,
      },
    );
    process.send?.(typeof id === 'string' ? 'queue-working' : 'queue-failed');
  } catch {
    process.send?.('queue-failed');
  }
}

process.on('message', (message: unknown) => {
  if (message === 'queue-check') {
    void checkQueue();
    return;
  }
  if (typeof message !== 'number') return;
  setImmediate(() => {
    setImmediate(() => {
      if (process.connected) process.send?.(message, () => undefined);
    });
  });
});
process.channel?.unref();

process.on('beforeExit', (code: number) => {
  writeSync(2, `entry-probe: beforeExit ${String(code)}\n`);
  writeSync(
    2,
    `entry-probe: signals ${String(process.listenerCount('SIGTERM'))} ${String(process.listenerCount('SIGINT'))}\n`,
  );
});
