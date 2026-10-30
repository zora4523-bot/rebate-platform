// B1-31b ⑤ (B1-31 review S2): main.<entry>.ts starts tracing before runEntry (bootTracing); when
// runEntry's startup then fails while creating the database handles (createDbHandles, or the
// worker's createMaintDbHandle) — before its own startTracing call — the failure still flushes and
// stops that tracing before runEntry returns: the pending span reaches the receiver, the provider is
// closed, startup_failed and exit code 1 are as before. activeTracing() names the running handle
// startTracing returned (null when none runs; it never starts one). Int test: loopback receiver.
import { afterEach, expect, it, vi } from 'vitest';
import {
  activeTracing,
  startTracing,
  type TracingHandle,
} from '../../../../apps/api/src/modules/platform/tracing/index.ts';
import { entryFixture, providerFootprint, type Entry, type FailAt } from './entry-kit.ts';
import { ENDPOINT_VAR, configOf, memoryLogger, otelApi, startReceiver } from './kit.ts';

const originalExitCode = process.exitCode;
const owned: TracingHandle[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  // shutdown() is idempotent: whatever this file started is stopped before the next test.
  for (const handle of owned.splice(0)) await handle.shutdown();
});

function pendingSpanName(entry: Entry, failAt: FailAt): string {
  return `b1-31b pending ${entry} ${failAt}`;
}

const FAILURES: [Entry, FailAt][] = [
  ['api', 'db-handles'],
  ['stream', 'db-handles'],
  ['worker', 'db-handles'],
  ['worker', 'maint-handle'],
];

it.each(FAILURES)(
  '[B1-31b ⑤] runEntry(%s), %s throws: startup_failed, exit 1, and the tracing main.<entry>.ts started is flushed and stopped before runEntry returns',
  async (entry: Entry, failAt: FailAt) => {
    const receiver = await startReceiver();
    try {
      const f = await entryFixture(entry, receiver.url, failAt);
      // What main.<entry>.ts does before loading the entry module (bootTracing → startTracing).
      const booted = await startTracing({ entry, config: f.config, logger: f.logger });
      owned.push(booted);
      expect(booted.enabled).toBe(true);
      // A span still waiting in the batch processor (its timer has not fired yet).
      otelApi().trace.getTracer('b1-31b').startSpan(pendingSpanName(entry, failAt)).end();

      await f.runEntry(entry);

      expect(process.exitCode).toBe(1);
      expect(f.messages()).toContain('startup_failed');
      expect(f.messages()).not.toContain('started');
      expect(f.atBuild).toEqual([]);
      // The primary handles exist only when the maintenance handle is what failed; they are closed.
      expect(f.handlesClosed()).toBe(failAt === 'maint-handle' ? 1 : 0);
      // Flushed before runEntry returned (not left to the batch timer), with the entry's resource.
      const name = pendingSpanName(entry, failAt);
      const pending = receiver.spans().filter((span) => span.name === name);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.resource['service.name']).toBe(`couli-${entry}`);
      expect(pending[0]?.resource['couli.entry']).toBe(entry);
      // Stopped: no provider, no propagator, no active handle; the booted handle's own shutdown is
      // then a no-op that resolves.
      expect(providerFootprint()).toEqual([]);
      expect(activeTracing()).toBeNull();
      await expect(booted.shutdown()).resolves.toBeUndefined();
    } finally {
      await receiver.close();
    }
  },
  30_000,
);

it('[B1-31b ⑤] activeTracing() is the running handle startTracing returned, null otherwise, and never starts one', async () => {
  const receiver = await startReceiver();
  try {
    const { logger } = memoryLogger('api');
    const config = configOf({ [ENDPOINT_VAR]: receiver.url });
    expect(activeTracing()).toBeNull();
    expect(providerFootprint()).toEqual([]);

    // A disabled handle (admin never traces) is not the active one.
    const disabled = await startTracing({ entry: 'admin', config, logger });
    owned.push(disabled);
    expect(disabled.enabled).toBe(false);
    expect(activeTracing()).toBeNull();

    const handle = await startTracing({ entry: 'api', config, logger });
    owned.push(handle);
    expect(handle.enabled).toBe(true);
    expect(activeTracing()).toBe(handle);
    // startTracing stays idempotent while it runs; activeTracing keeps naming the same handle.
    expect(await startTracing({ entry: 'api', config, logger })).toBe(handle);
    expect(activeTracing()).toBe(handle);

    await handle.shutdown();
    expect(activeTracing()).toBeNull();
    expect(providerFootprint()).toEqual([]);

    // A later start is the new active handle, stopped through activeTracing() itself.
    const again = await startTracing({ entry: 'worker', config, logger });
    owned.push(again);
    expect(again).not.toBe(handle);
    expect(activeTracing()).toBe(again);
    await activeTracing()?.shutdown();
    expect(activeTracing()).toBeNull();
    expect(providerFootprint()).toEqual([]);
  } finally {
    await receiver.close();
  }
}, 30_000);
