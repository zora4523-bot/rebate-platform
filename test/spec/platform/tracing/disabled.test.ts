// [AC-B1-31#3] endpoint unset (or empty) → startTracing returns enabled=false and installs nothing:
// no global tracer provider or propagator, no patched http, no undici subscriber, and requests
// behave exactly as before (02 §13: X-Trace-Id kept as sent or a random UUID, echoed in the
// response header and the envelope's trace_id). [AC-B1-31#9] admin and payout never trace, even
// with an endpoint (payout's outbound allowlist is PG and the channel only, ADR-0001 §4.2 #20).
// Settings come only from the loaded configuration, never from process.env (AGENTS.md rule 6).
// Unit tests: HTTP through Fastify inject only, no port.
import { expect, it } from 'vitest';
import { startTracing } from '../../../../apps/api/src/modules/platform/tracing/otel.ts';
import {
  ENDPOINT_VAR,
  SAMPLER_VAR,
  SERVICE_VAR,
  UUID,
  configOf,
  createEntryApp,
  memoryLogger,
  tracingFootprint,
} from './kit.ts';

const ENDPOINT = 'http://127.0.0.1:9/insert/opentelemetry/v1/traces';

it.each(['api', 'stream', 'worker', 'admin', 'payout'] as const)(
  '[AC-B1-31#3] %s without OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: enabled=false, nothing installed',
  async (entry) => {
    const { logger } = memoryLogger(entry);
    const handle = await startTracing({ entry, config: configOf(), logger });
    expect(handle.enabled).toBe(false);
    expect(tracingFootprint()).toEqual([]);
    await expect(handle.shutdown()).resolves.toBeUndefined();
    expect(tracingFootprint()).toEqual([]);
  },
);

it.each(['api', 'stream', 'worker'] as const)(
  '[AC-B1-31#3] %s with an empty endpoint counts as unset',
  async (entry) => {
    const { logger } = memoryLogger(entry);
    const handle = await startTracing({
      entry,
      config: configOf({ [ENDPOINT_VAR]: '', [SAMPLER_VAR]: '' }),
      logger,
    });
    expect(handle.enabled).toBe(false);
    expect(tracingFootprint()).toEqual([]);
    await handle.shutdown();
  },
);

it.each(['admin', 'payout'] as const)(
  '[AC-B1-31#9] %s with an endpoint configured: enabled=false, nothing installed',
  async (entry) => {
    const { logger } = memoryLogger(entry);
    const handle = await startTracing({
      entry,
      config: configOf({ [ENDPOINT_VAR]: ENDPOINT, [SAMPLER_VAR]: '1', [SERVICE_VAR]: 'x' }),
      logger,
    });
    expect(handle.enabled).toBe(false);
    expect(tracingFootprint()).toEqual([]);
    await expect(handle.shutdown()).resolves.toBeUndefined();
  },
);

it('[AC-B1-31#3] OTEL_* variables in process.env alone do not enable tracing (only loadConfig counts)', async () => {
  const saved = { ...process.env };
  process.env[ENDPOINT_VAR] = ENDPOINT;
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:9';
  process.env[SAMPLER_VAR] = '1';
  try {
    const { logger } = memoryLogger('api');
    // The configuration was loaded without them (as from an environment that lacks them).
    const handle = await startTracing({ entry: 'api', config: configOf(), logger });
    expect(handle.enabled).toBe(false);
    expect(tracingFootprint()).toEqual([]);
    await handle.shutdown();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

it('[AC-B1-31#3] with tracing off the api entry answers exactly as before (02 §13 unchanged)', async () => {
  const { logger, records } = memoryLogger('api');
  const config = configOf();
  const handle = await startTracing({ entry: 'api', config, logger });
  expect(handle.enabled).toBe(false);
  const app = await createEntryApp('api', config, logger);
  try {
    await app.init();
    for (const inbound of [
      'C56A4180-65aa-42EC-a945-5fd21DEC0538',
      'abcdefABCDEF01234567abcdefABCDEF',
    ]) {
      const kept = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-trace-id': inbound },
      });
      expect(kept.statusCode).toBe(200);
      expect(kept.headers['x-trace-id']).toBe(inbound);
      expect((kept.json() as { trace_id: string }).trace_id).toBe(inbound);
      expect(records().some((record) => record.reqId === inbound)).toBe(true);
    }
    const fresh = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-trace-id': 'trace-abc_123' },
    });
    expect(fresh.statusCode).toBe(200);
    const id = String(fresh.headers['x-trace-id']);
    expect(id).toMatch(UUID);
    expect((fresh.json() as { trace_id: string }).trace_id).toBe(id);
    expect(fresh.headers['traceparent']).toBeUndefined();
    expect(tracingFootprint()).toEqual([]);
  } finally {
    await app.close();
    await handle.shutdown();
  }
});
