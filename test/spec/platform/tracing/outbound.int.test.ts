// [AC-B1-31#6] outbound HTTP on the worker entry (05 B1-31: 外部 HTTP 自动插桩): fetch (undici) and
// node:http requests leave a client span and carry W3C traceparent plus x-trace-id (the trace id in
// UUID form) to the upstream; inside an active span they continue its trace. Resource:
// OTEL_SERVICE_NAME overrides the service name; without COULI_DEPLOY_VERSION service.version is 'dev'.
// Int test: a loopback upstream and a loopback OTLP receiver. Tracing starts before anything here
// issues a request.
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, expect, it } from 'vitest';
import { startTracing } from '../../../../apps/api/src/modules/platform/tracing/otel.ts';
import {
  CLIENT,
  ENDPOINT_VAR,
  EXPORT_WAIT_MS,
  SERVICE_VAR,
  TRACEPARENT,
  configOf,
  lazily,
  memoryLogger,
  otelApi,
  uuidOf,
  waitFor,
  withReceiver,
  type ReceivedSpan,
  type Receiver,
} from './kit.ts';

interface Upstream {
  readonly url: string;
  readonly seen: Map<string, IncomingHttpHeaders>;
  close(): Promise<void>;
}

interface Setup {
  readonly receiver: Receiver;
  readonly upstream: Upstream;
  readonly shutdown: () => Promise<void>;
}

let started: Setup | undefined;

async function startUpstream(): Promise<Upstream> {
  const seen = new Map<string, IncomingHttpHeaders>();
  const server = http.createServer((req, res) => {
    seen.set(req.url ?? '', req.headers);
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const setup = lazily(() =>
  withReceiver(async (receiver): Promise<Setup> => {
    const { logger } = memoryLogger('worker');
    const config = configOf({ [ENDPOINT_VAR]: receiver.url, [SERVICE_VAR]: 'couli-worker-b1-31' });
    const handle = await startTracing({ entry: 'worker', config, logger });
    expect(handle.enabled).toBe(true);
    const upstream = await startUpstream();
    started = { receiver, upstream, shutdown: () => handle.shutdown() };
    return started;
  }),
);

afterAll(async () => {
  if (started === undefined) return;
  await started.shutdown();
  await started.upstream.close();
  await started.receiver.close();
});

function headerOf(headers: IncomingHttpHeaders | undefined, name: string): string {
  const value = headers?.[name];
  return Array.isArray(value) ? value.join(',') : (value ?? '');
}

async function clientSpan(
  receiver: Receiver,
  traceId: string,
  spanId: string,
): Promise<ReceivedSpan> {
  const find = () =>
    receiver
      .spans()
      .find((span) => span.traceId === traceId && span.spanId === spanId && span.kind === CLIENT);
  expect(await waitFor(() => find() !== undefined, EXPORT_WAIT_MS)).toBe(true);
  return find()!;
}

function getWithHttp(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      })
      .on('error', reject);
  });
}

it('[AC-B1-31#6] fetch without an active span: a new trace, its client span, traceparent and x-trace-id upstream', async () => {
  const { receiver, upstream } = await setup();
  const response = await fetch(`${upstream.url}/fetch-root`);
  expect(response.status).toBe(200);
  await response.text();
  const headers = upstream.seen.get('/fetch-root');
  const traceparent = headerOf(headers, 'traceparent');
  const match = TRACEPARENT.exec(traceparent);
  expect(match, `traceparent: ${traceparent}`).not.toBeNull();
  const [, traceId = '', parentId = ''] = match ?? [];
  expect(headerOf(headers, 'x-trace-id')).toBe(uuidOf(traceId));
  const span = await clientSpan(receiver, traceId, parentId);
  expect(span.resource['service.name']).toBe('couli-worker-b1-31');
  expect(span.resource['service.version']).toBe('dev');
});

it('[AC-B1-31#6] fetch inside an active span continues its trace: the client span is its child', async () => {
  const { receiver, upstream } = await setup();
  const tracer = otelApi().trace.getTracer('b1-31-rule');
  const parent = await tracer.startActiveSpan('b1-31-parent', async (span) => {
    try {
      const response = await fetch(`${upstream.url}/fetch-child`);
      await response.text();
      return span.spanContext();
    } finally {
      span.end();
    }
  });
  const headers = upstream.seen.get('/fetch-child');
  const match = TRACEPARENT.exec(headerOf(headers, 'traceparent'));
  expect(match).not.toBeNull();
  const [, traceId = '', parentId = ''] = match ?? [];
  expect(traceId).toBe(parent.traceId);
  expect(parentId).not.toBe(parent.spanId);
  expect(headerOf(headers, 'x-trace-id')).toBe(uuidOf(parent.traceId));
  const span = await clientSpan(receiver, traceId, parentId);
  expect(span.parentSpanId).toBe(parent.spanId);
});

it('[AC-B1-31#6] node:http outbound requests are instrumented the same way', async () => {
  const { receiver, upstream } = await setup();
  expect(await getWithHttp(`${upstream.url}/http-get`)).toBe(200);
  const headers = upstream.seen.get('/http-get');
  const match = TRACEPARENT.exec(headerOf(headers, 'traceparent'));
  expect(match).not.toBeNull();
  const [, traceId = '', parentId = ''] = match ?? [];
  expect(headerOf(headers, 'x-trace-id')).toBe(uuidOf(traceId));
  await clientSpan(receiver, traceId, parentId);
});

it('[AC-B1-31#10] outbound client spans carry no query value or auth header', async () => {
  const { receiver, upstream } = await setup();
  const secret = 'fakeoutboundsecretfortest';
  const response = await fetch(`${upstream.url}/fetch-private?access_token=${secret}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  await response.text();
  const headers = upstream.seen.get(`/fetch-private?access_token=${secret}`);
  const match = TRACEPARENT.exec(headerOf(headers, 'traceparent'));
  expect(match).not.toBeNull();
  const [, traceId = '', parentId = ''] = match ?? [];
  await clientSpan(receiver, traceId, parentId);
  for (const request of receiver.requests) {
    expect(request.body.includes(secret)).toBe(false);
  }
});
