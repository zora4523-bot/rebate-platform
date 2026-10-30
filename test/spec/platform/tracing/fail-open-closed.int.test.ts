// [AC-B1-31#5] fail-open with nothing listening at the endpoint (VictoriaTraces down) on the api
// entry: requests stay 200, the failure is a warn line `otel_export_failed`, the process keeps
// running and shutdown() returns within 2 s without rejecting.
// Int test: the entry on a loopback port; the endpoint is a loopback port that was just closed.
import { afterAll, expect, it } from 'vitest';
import { startTracing } from '../../../../apps/api/src/modules/platform/tracing/otel.ts';
import {
  ENDPOINT_VAR,
  EXPORT_WAIT_MS,
  UUID,
  closedEndpoint,
  configOf,
  createEntryApp,
  lazily,
  listenOn,
  memoryLogger,
  send,
  waitFor,
  type EntryApp,
  type LogRecord,
} from './kit.ts';

interface Setup {
  readonly app: EntryApp;
  readonly port: number;
  readonly records: () => LogRecord[];
  readonly shutdown: () => Promise<void>;
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
let started: Setup | undefined;

const setup = lazily(async (): Promise<Setup> => {
  process.on('unhandledRejection', onUnhandled);
  const { logger, records } = memoryLogger('api');
  const config = configOf({ [ENDPOINT_VAR]: await closedEndpoint() });
  const handle = await startTracing({ entry: 'api', config, logger });
  expect(handle.enabled).toBe(true);
  const app = await createEntryApp('api', config, logger);
  const port = await listenOn(app);
  started = { app, port, records, shutdown: () => handle.shutdown() };
  return started;
});

afterAll(async () => {
  process.off('unhandledRejection', onUnhandled);
  if (started === undefined) return;
  await started.app.close();
  await started.shutdown();
});

it('[AC-B1-31#5] endpoint unreachable: requests stay 200, one warn otel_export_failed, shutdown within 2 s', async () => {
  const { port, records, shutdown } = await setup();
  for (let i = 0; i < 3; i += 1) {
    const response = await send(port, { path: '/healthz' });
    expect(response.status).toBe(200);
    expect(response.headers['x-trace-id']).toMatch(UUID);
  }
  const failed = (): LogRecord[] =>
    records().filter((record) => record.msg === 'otel_export_failed');
  expect(await waitFor(() => failed().length > 0, EXPORT_WAIT_MS + 15_000)).toBe(true);
  expect(failed()).toHaveLength(1);
  expect(typeof failed()[0]?.['error_name']).toBe('string');
  expect(Number(failed()[0]?.['count'])).toBeGreaterThanOrEqual(1);
  const after = await send(port, { path: '/healthz' });
  expect(after.status).toBe(200);
  const t0 = performance.now();
  await expect(shutdown()).resolves.toBeUndefined();
  expect(performance.now() - t0).toBeLessThan(2_500);
  const last = await send(port, { path: '/healthz' });
  expect(last.status).toBe(200);
  expect(unhandled).toEqual([]);
});
