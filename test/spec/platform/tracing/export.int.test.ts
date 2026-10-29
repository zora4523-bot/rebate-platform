// [AC-B1-31#4] api → OTLP/HTTP: every request leaves a server span whose trace id is the request id
// of the X-Trace-Id response header, the envelope's trace_id and the log line (02 §13 unchanged: a
// well-formed inbound X-Trace-Id is kept as sent, otherwise a random UUID), with couli.trace_id and
// couli.entry. [AC-B1-31#10] span attributes hold method, path and status only: no body, query
// string, auth or signature header reaches the exporter. [AC-B1-31#8] shutdown() flushes, then
// nothing more is exported and requests still succeed.
// Int test: a loopback OTLP receiver and the entry listening on a loopback port (the instrumented
// HTTP server, as in production), driven by a raw socket client (the test side adds no header).
// Tracing starts before the entry is imported, as the entries do.
import { afterAll, expect, it } from 'vitest';
import { startTracing } from '../../../../apps/api/src/modules/platform/tracing/otel.ts';
import {
  ENDPOINT_VAR,
  EXPORT_WAIT_MS,
  HEX32,
  SAMPLER_VAR,
  SERVER,
  UUID,
  attributeOf,
  configOf,
  createEntryApp,
  hexOf,
  lazily,
  listenOn,
  memoryLogger,
  send,
  sleep,
  waitFor,
  withReceiver,
  type EntryApp,
  type ReceivedSpan,
  type Receiver,
} from './kit.ts';

interface Setup {
  readonly receiver: Receiver;
  readonly app: EntryApp;
  readonly port: number;
  readonly records: ReturnType<typeof memoryLogger>['records'];
  readonly lines: string[];
  readonly shutdown: () => Promise<void>;
}

let started: Setup | undefined;

const setup = lazily(() =>
  withReceiver(async (receiver): Promise<Setup> => {
    const { logger, lines, records } = memoryLogger('api');
    const config = configOf({
      [ENDPOINT_VAR]: receiver.url,
      [SAMPLER_VAR]: '1',
      COULI_DEPLOY_VERSION: 'b1-31-rule',
    });
    const handle = await startTracing({ entry: 'api', config, logger });
    expect(handle.enabled).toBe(true);
    const app = await createEntryApp('api', config, logger);
    const port = await listenOn(app);
    started = { receiver, app, port, records, lines, shutdown: () => handle.shutdown() };
    return started;
  }),
);

afterAll(async () => {
  if (started === undefined) return;
  await started.app.close();
  await started.shutdown();
  await started.receiver.close();
});

async function serverSpanOf(receiver: Receiver, traceId: string): Promise<ReceivedSpan> {
  const find = () =>
    receiver.spans().find((span) => span.traceId === traceId && span.kind === SERVER);
  expect(await waitFor(() => find() !== undefined, EXPORT_WAIT_MS)).toBe(true);
  return find()!;
}

function envelopeTraceId(body: string): unknown {
  return (JSON.parse(body) as { trace_id?: unknown }).trace_id;
}

it('[AC-B1-31#4] a request without X-Trace-Id: server span trace id = the UUID of the response header, the envelope and the log line', async () => {
  const { receiver, port, records } = await setup();
  const response = await send(port, { path: '/healthz' });
  expect(response.status).toBe(200);
  const requestId = response.headers['x-trace-id'] ?? '';
  expect(requestId).toMatch(UUID);
  expect(envelopeTraceId(response.body)).toBe(requestId);
  expect(records().some((record) => record.reqId === requestId)).toBe(true);
  const span = await serverSpanOf(receiver, hexOf(requestId));
  expect(span.traceId).toMatch(HEX32);
  expect(span.attributes['couli.trace_id']).toBe(requestId);
  expect(span.attributes['couli.entry']).toBe('api');
  expect(attributeOf(span.attributes, 'http.request.method', 'http.method')).toBe('GET');
  expect(attributeOf(span.attributes, 'http.response.status_code', 'http.status_code')).toBe(200);
  expect(span.resource['service.name']).toBe('couli-api');
  expect(span.resource['service.version']).toBe('b1-31-rule');
  expect(attributeOf(span.resource, 'deployment.environment', 'deployment.environment.name')).toBe(
    'test',
  );
});

it.each([
  'C56A4180-65aa-42EC-a945-5fd21DEC0538',
  '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b',
  'ABCDEF0123456789abcdef0123456789',
])(
  '[AC-B1-31#4] a well-formed X-Trace-Id %s is kept as sent and is the span trace id',
  async (inbound) => {
    const { receiver, port, records } = await setup();
    const response = await send(port, { path: '/healthz', headers: { 'x-trace-id': inbound } });
    expect(response.status).toBe(200);
    expect(response.headers['x-trace-id']).toBe(inbound);
    expect(envelopeTraceId(response.body)).toBe(inbound);
    expect(records().some((record) => record.reqId === inbound)).toBe(true);
    const span = await serverSpanOf(receiver, hexOf(inbound));
    expect(span.attributes['couli.trace_id']).toBe(inbound);
    expect(span.attributes['couli.entry']).toBe('api');
  },
);

it('[AC-B1-31#4] a malformed X-Trace-Id and an inbound traceparent are not adopted: fresh UUID, same trace in the span', async () => {
  const { receiver, port } = await setup();
  const foreign = '4bf92f3577b34da6a3ce929d0e0e4736';
  const response = await send(port, {
    path: '/healthz',
    headers: { 'x-trace-id': 'trace-abc_123', traceparent: `00-${foreign}-00f067aa0ba902b7-01` },
  });
  expect(response.status).toBe(200);
  const requestId = response.headers['x-trace-id'] ?? '';
  expect(requestId).toMatch(UUID);
  expect(hexOf(requestId)).not.toBe(foreign);
  const span = await serverSpanOf(receiver, hexOf(requestId));
  expect(span.attributes['couli.trace_id']).toBe(requestId);
  expect(receiver.spans().some((received) => received.traceId === foreign)).toBe(false);
});

it('[AC-B1-31#10] no body, query value, auth, cookie or signature header reaches the exporter', async () => {
  const { receiver, port, lines } = await setup();
  const markers = {
    query: 'b131qrytoken5d2e',
    phone: '13800138000',
    authorization: 'b131authsecret9c1f',
    cookie: 'b131cookiesecret44ab',
    sign: 'b131signsecret0e77',
    body: 'b131bodysecret61aa',
  };
  const get = await send(port, {
    path: `/healthz?token=${markers.query}&phone=${markers.phone}`,
    headers: {
      authorization: `Bearer ${markers.authorization}`,
      cookie: `sid=${markers.cookie}`,
      'x-sign': markers.sign,
    },
  });
  expect(get.status).toBe(200);
  const post = await send(port, {
    method: 'POST',
    path: '/v1/b1-31-probe',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${markers.authorization}`,
    },
    body: JSON.stringify({ secret: markers.body, phone: markers.phone }),
  });
  const getSpan = await serverSpanOf(receiver, hexOf(get.headers['x-trace-id'] ?? ''));
  await serverSpanOf(receiver, hexOf(post.headers['x-trace-id'] ?? ''));
  expect(attributeOf(getSpan.attributes, 'http.request.method', 'http.method')).toBe('GET');
  expect(attributeOf(getSpan.attributes, 'http.response.status_code', 'http.status_code')).toBe(
    200,
  );
  for (const request of receiver.requests) {
    for (const marker of Object.values(markers)) {
      expect(request.body.includes(marker), `exported body contains ${marker}`).toBe(false);
    }
  }
  // Tracing's own log lines (otel_*) quote none of them either.
  const tracingLines = lines.filter((line) => line.includes('"otel'));
  for (const marker of Object.values(markers)) {
    expect(tracingLines.join('\n')).not.toContain(marker);
  }
});

it('[AC-B1-31#8] shutdown() flushes pending spans within 2 s; afterwards nothing is exported and requests still succeed', async () => {
  const { receiver, port, shutdown } = await setup();
  const before = await send(port, { path: '/healthz' });
  expect(before.status).toBe(200);
  const pending = hexOf(before.headers['x-trace-id'] ?? '');
  const t0 = performance.now();
  await expect(shutdown()).resolves.toBeUndefined();
  expect(performance.now() - t0).toBeLessThan(2_500);
  // Flushed by shutdown itself, not by a later batch.
  expect(receiver.spans().some((span) => span.traceId === pending && span.kind === SERVER)).toBe(
    true,
  );
  const exported = receiver.requests.length;
  const after = await send(port, { path: '/healthz' });
  expect(after.status).toBe(200);
  const requestId = after.headers['x-trace-id'] ?? '';
  expect(requestId).toMatch(UUID);
  expect(envelopeTraceId(after.body)).toBe(requestId);
  await sleep(6_000);
  expect(receiver.requests.length).toBe(exported);
  // A second shutdown (the entry's close path may run twice) neither rejects nor exports.
  await expect(shutdown()).resolves.toBeUndefined();
  expect(receiver.requests.length).toBe(exported);
});
