// [AC-B1-31#5] fail-open on the stream entry (05 B1-31: traces only for troubleshooting, never a
// dependency of a request): a receiver answering 500 or never answering changes no response; the
// failure is one warn line `otel_export_failed` (error_name, count) at most once a minute; nothing
// is thrown into the process; shutdown() still returns within 2 s while an export hangs.
// Int test: loopback receiver and the entry on a loopback port; raw socket client.
import { afterAll, expect, it } from 'vitest';
import { startTracing } from '../../../../apps/api/src/modules/platform/tracing/otel.ts';
import {
  ENDPOINT_VAR,
  EXPORT_WAIT_MS,
  UUID,
  configOf,
  createEntryApp,
  lazily,
  listenOn,
  memoryLogger,
  send,
  waitFor,
  withReceiver,
  type EntryApp,
  type LogRecord,
  type Receiver,
} from './kit.ts';

interface Setup {
  readonly receiver: Receiver;
  readonly app: EntryApp;
  readonly port: number;
  readonly records: () => LogRecord[];
  readonly shutdown: () => Promise<void>;
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
let started: Setup | undefined;

const setup = lazily(() =>
  withReceiver(async (receiver): Promise<Setup> => {
    process.on('unhandledRejection', onUnhandled);
    receiver.mode = 'fail';
    const { logger, records } = memoryLogger('stream');
    const config = configOf({ [ENDPOINT_VAR]: receiver.url });
    const handle = await startTracing({ entry: 'stream', config, logger });
    expect(handle.enabled).toBe(true);
    const app = await createEntryApp('stream', config, logger);
    const port = await listenOn(app);
    started = { receiver, app, port, records, shutdown: () => handle.shutdown() };
    return started;
  }),
);

afterAll(async () => {
  process.off('unhandledRejection', onUnhandled);
  if (started === undefined) return;
  await started.app.close();
  await started.shutdown();
  await started.receiver.close();
});

function warned(records: () => LogRecord[]): LogRecord[] {
  return records().filter((record) => record.msg === 'otel_export_failed');
}

function epochMs(time: LogRecord['time']): number {
  return typeof time === 'number' ? time : Date.parse(String(time));
}

async function healthy(port: number): Promise<void> {
  const t0 = performance.now();
  const response = await send(port, { path: '/healthz' });
  expect(response.status).toBe(200);
  expect(response.headers['x-trace-id']).toMatch(UUID);
  // The response does not wait for any export.
  expect(performance.now() - t0).toBeLessThan(2_000);
}

it('[AC-B1-31#5] receiver answers 500: requests stay 200; one warn otel_export_failed with error_name and count', async () => {
  const { receiver, port, records } = await setup();
  await healthy(port);
  await healthy(port);
  expect(await waitFor(() => receiver.requests.length > 0, EXPORT_WAIT_MS)).toBe(true);
  expect(await waitFor(() => warned(records).length > 0, 15_000)).toBe(true);
  const [line] = warned(records);
  expect(line?.level).toBe(40);
  expect(typeof line?.['error_name']).toBe('string');
  expect(String(line?.['error_name'])).not.toBe('');
  expect(Number.isInteger(line?.['count'])).toBe(true);
  expect(Number(line?.['count'])).toBeGreaterThanOrEqual(1);
  expect(line).not.toHaveProperty('err');
  expect(line).not.toHaveProperty('stack');
  await healthy(port);
});

it('[AC-B1-31#5] receiver never answers: requests stay 200 and fast while the export hangs', async () => {
  const { receiver, port } = await setup();
  receiver.mode = 'hang';
  const seen = receiver.requests.length;
  for (let i = 0; i < 5; i += 1) await healthy(port);
  expect(await waitFor(() => receiver.requests.length > seen, EXPORT_WAIT_MS)).toBe(true);
  for (let i = 0; i < 5; i += 1) await healthy(port);
});

it('[AC-B1-31#5] shutdown() returns within 2 s even with an export hanging, and does not reject', async () => {
  const { port, shutdown } = await setup();
  await healthy(port);
  const t0 = performance.now();
  await expect(shutdown()).resolves.toBeUndefined();
  expect(performance.now() - t0).toBeLessThan(2_500);
  await healthy(port);
});

it('[AC-B1-31#5] warn lines are at least a minute apart, counts only grow, nothing reached the process', async () => {
  const { records } = await setup();
  const lines = warned(records);
  expect(lines.length).toBeGreaterThanOrEqual(1);
  for (let i = 1; i < lines.length; i += 1) {
    expect(epochMs(lines[i]?.time) - epochMs(lines[i - 1]?.time)).toBeGreaterThanOrEqual(59_000);
    expect(Number(lines[i]?.['count'])).toBeGreaterThan(Number(lines[i - 1]?.['count']));
  }
  expect(unhandled).toEqual([]);
});
