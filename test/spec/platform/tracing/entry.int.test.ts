// B1-31b ① / ② (B1-31 review S2): through runEntry itself, api / stream / worker have tracing in
// place before the application / worker context is built — the footprint is there when the entry
// builds it, and a span recorded right then reaches the receiver with the entry's resource
// (service.name couli-<entry> when OTEL_SERVICE_NAME is unset, couli.entry <entry>) — and the
// provider is closed once the entry exits (COULI_EXIT_AFTER_INIT=1). admin and payout, with the
// endpoint set all the same, leave no footprint and export nothing. Int test: loopback receiver.
// The untraced entries run first, while this process has had no tracing at all.
import { afterEach, expect, it, vi } from 'vitest';
import { activeTracing } from '../../../../apps/api/src/modules/platform/tracing/index.ts';
import {
  TRACED,
  UNTRACED,
  buildSpanName,
  entryFixture,
  providerFootprint,
  type Entry,
} from './entry-kit.ts';
import { startReceiver } from './kit.ts';

const originalExitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

it.each(UNTRACED.map((entry) => [entry]))(
  '[B1-31b ①] runEntry(%s) with the endpoint set: no tracing footprint while it builds, none after, nothing exported',
  async (entry: Entry) => {
    const receiver = await startReceiver();
    try {
      const f = await entryFixture(entry, receiver.url);
      await f.runEntry(entry);
      expect(process.exitCode, `${entry} failed to start`).toBe(originalExitCode);
      expect(f.messages()).toContain('started');
      expect(f.atBuild).toEqual([[]]);
      expect(f.messages()).not.toContain('otel_tracing_started');
      expect(providerFootprint()).toEqual([]);
      expect(activeTracing()).toBeNull();
      expect(receiver.requests).toEqual([]);
    } finally {
      await receiver.close();
    }
  },
  30_000,
);

it.each(TRACED.map((entry) => [entry]))(
  '[B1-31b ①②] runEntry(%s): tracing is in place before the app is built, exports with the entry resource, and is closed on exit',
  async (entry: Entry) => {
    const receiver = await startReceiver();
    try {
      const f = await entryFixture(entry, receiver.url);
      await f.runEntry(entry);
      expect(process.exitCode, `${entry} failed to start`).toBe(originalExitCode);
      expect(f.messages()).toContain('started');
      // Before the build: started, and installed.
      const messages = f.messages();
      expect(messages.indexOf('otel_tracing_started')).toBeGreaterThanOrEqual(0);
      expect(messages.indexOf('otel_tracing_started')).toBeLessThan(messages.indexOf('started'));
      expect(f.atBuild).toHaveLength(1);
      const [atBuild = []] = f.atBuild;
      expect(atBuild).toContain('global tracer provider');
      expect(atBuild.some((item) => item.startsWith('global propagator'))).toBe(true);
      // The span recorded while building was flushed on exit, with the entry's resource.
      const built = receiver.spans().filter((span) => span.name === buildSpanName(entry));
      expect(built).toHaveLength(1);
      expect(built[0]?.resource['service.name']).toBe(`couli-${entry}`);
      expect(built[0]?.resource['couli.entry']).toBe(entry);
      // Closed on exit: no provider, no propagator, no active handle.
      expect(providerFootprint()).toEqual([]);
      expect(activeTracing()).toBeNull();
    } finally {
      await receiver.close();
    }
  },
  30_000,
);
