// [AC-B1-31#3] OTEL_TRACES_SAMPLER_ARG=0 on the api entry: tracing is on but samples nothing, so no
// span of those requests is exported, while the request id behaves as 02 §13 says (kept when
// well-formed, else a UUID; in the header, the envelope and the log line).
// Int test: loopback receiver and the entry on a loopback port; raw socket client.
import { afterAll, expect, it } from 'vitest';
import { startTracing } from '../../../../apps/api/src/modules/platform/tracing/otel.ts';
import {
  ENDPOINT_VAR,
  SAMPLER_VAR,
  UUID,
  configOf,
  createEntryApp,
  hexOf,
  lazily,
  listenOn,
  memoryLogger,
  send,
  sleep,
  withReceiver,
  type EntryApp,
  type Receiver,
} from './kit.ts';

let started: { receiver: Receiver; app: EntryApp; shutdown: () => Promise<void> } | undefined;

const setup = lazily(() =>
  withReceiver(async (receiver) => {
    const { logger, records } = memoryLogger('api');
    const config = configOf({ [ENDPOINT_VAR]: receiver.url, [SAMPLER_VAR]: '0' });
    const handle = await startTracing({ entry: 'api', config, logger });
    expect(handle.enabled).toBe(true);
    const app = await createEntryApp('api', config, logger);
    const port = await listenOn(app);
    started = { receiver, app, shutdown: () => handle.shutdown() };
    return { receiver, port, records, shutdown: () => handle.shutdown() };
  }),
);

afterAll(async () => {
  if (started === undefined) return;
  await started.app.close();
  await started.shutdown();
  await started.receiver.close();
});

it('[AC-B1-31#3] sample ratio 0: requests keep their request ids and no span of theirs is exported', async () => {
  const { receiver, port, records, shutdown } = await setup();
  const inbound = 'C56A4180-65aa-42EC-a945-5fd21DEC0538';
  const kept = await send(port, { path: '/healthz', headers: { 'x-trace-id': inbound } });
  expect(kept.status).toBe(200);
  expect(kept.headers['x-trace-id']).toBe(inbound);
  const fresh = await send(port, { path: '/healthz' });
  expect(fresh.status).toBe(200);
  const freshId = fresh.headers['x-trace-id'] ?? '';
  expect(freshId).toMatch(UUID);
  expect((JSON.parse(fresh.body) as { trace_id: string }).trace_id).toBe(freshId);
  for (const id of [inbound, freshId]) {
    expect(records().some((record) => record.reqId === id)).toBe(true);
  }
  await sleep(6_000);
  await expect(shutdown()).resolves.toBeUndefined();
  const traced = new Set([hexOf(inbound), hexOf(freshId)]);
  expect(receiver.spans().filter((span) => traced.has(span.traceId))).toEqual([]);
});
