// Shared helpers of the B1-31 tracing rule tests (05 B1-31; 02 §13; 06 Q-A9). Expected values are
// written out from the task text, never taken from the implementation: the request id ↔ trace id
// conversion below is a hand-written oracle. Only *.int.test.ts files call startReceiver / send /
// listen (they open loopback ports); the unit files use nothing here that opens a port.
import { hasSubscribers } from 'node:diagnostics_channel';
import http from 'node:http';
import { createRequire } from 'node:module';
import net, { type AddressInfo } from 'node:net';
import { gunzipSync, inflateSync } from 'node:zlib';
import {
  loadConfig,
  type AppConfig,
} from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import type { createTracePropagator } from '../../../../apps/api/src/modules/platform/tracing/trace-correlation.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));

export const ENDPOINT_VAR = 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT';
export const SAMPLER_VAR = 'OTEL_TRACES_SAMPLER_ARG';
export const SERVICE_VAR = 'OTEL_SERVICE_NAME';

/** Lowercase UUID 8-4-4-4-12 (any version nibble: it is a trace id, not a v4 UUID). */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HEX32 = /^[0-9a-f]{32}$/;
export const HEX16 = /^[0-9a-f]{16}$/;
/** W3C traceparent, version 00: trace id, parent span id, flags 00 / 01. */
export const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0([01])$/;
export const INVALID_TRACE_ID = '0'.repeat(32);
export const INVALID_SPAN_ID = '0'.repeat(16);

/** OTLP span kinds. */
export const SERVER = 2;
export const CLIENT = 3;

// ---------------------------------------------------------------------------------------------
// Oracle: request id ↔ trace id, written by hand.

/** A well-formed request id (32 hex or UUID, any case) as 32 lowercase hex digits. */
export function hexOf(requestId: string): string {
  return requestId.replaceAll('-', '').toLowerCase();
}

/** 32 hex digits as a lowercase UUID 8-4-4-4-12. */
export function uuidOf(hex: string): string {
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------------------------------------
// The OpenTelemetry API, loaded from apps/api (the test package does not depend on it). Its global
// state lives under a Symbol.for key, so this instance and the implementation's share it.

type Propagator = ReturnType<typeof createTracePropagator>;
export type Ctx = Parameters<Propagator['extract']>[0];
export type Getter = Parameters<Propagator['extract']>[2];
export type Setter = Parameters<Propagator['inject']>[2];

export interface SpanContextLike {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly isRemote?: boolean;
}
export interface SpanLike {
  spanContext(): SpanContextLike;
  end(): void;
}
export interface TracerLike {
  startSpan(name: string): SpanLike;
  startActiveSpan<T>(name: string, run: (span: SpanLike) => T): T;
}
export interface OtelApi {
  readonly ROOT_CONTEXT: Ctx;
  readonly defaultTextMapGetter: Getter;
  readonly defaultTextMapSetter: Setter;
  readonly trace: {
    getSpanContext(context: Ctx): SpanContextLike | undefined;
    setSpanContext(context: Ctx, spanContext: SpanContextLike): Ctx;
    getTracer(name: string): TracerLike;
  };
  readonly propagation: { fields(): string[] };
}

export function otelApi(): OtelApi {
  return apiRequire('@opentelemetry/api') as OtelApi;
}

function isWrapped(value: unknown): boolean {
  return typeof value === 'function' && ('__wrapped' in value || '__original' in value);
}

/**
 * What tracing has installed in this process: a global tracer provider that records spans, a
 * global propagator, patched http functions, subscribers on undici's diagnostics channels. Empty
 * when nothing was installed ("未设 = 不导出、不装插桩").
 */
export function tracingFootprint(api: OtelApi = otelApi()): string[] {
  const found: string[] = [];
  const span = api.trace.getTracer('b1-31-probe').startSpan('probe');
  if (span.spanContext().traceId !== INVALID_TRACE_ID) found.push('global tracer provider');
  span.end();
  const fields = api.propagation.fields();
  if (fields.length > 0) found.push(`global propagator (${fields.join(',')})`);
  if (isWrapped(http.request)) found.push('http.request patched');
  if (isWrapped(http.get)) found.push('http.get patched');
  if (isWrapped(http.Server.prototype.emit)) found.push('http.Server emit patched');
  for (const channel of ['undici:request:create', 'undici:request:headers']) {
    if (hasSubscribers(channel)) found.push(`subscriber on ${channel}`);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Configuration and logging.

/** loadConfig with APP_ENV=test plus `env` (the only way tracing gets its settings). */
export function configOf(env: Readonly<Record<string, string | undefined>> = {}): AppConfig {
  return loadConfig({ APP_ENV: 'test', ...env });
}

export interface LogRecord {
  readonly level: number;
  readonly msg?: string;
  readonly time?: number | string;
  readonly reqId?: string;
  readonly [key: string]: unknown;
}

/** A root logger of `entry` whose JSON lines are kept in `lines`. */
export function memoryLogger(entry: string): {
  logger: RootLogger;
  lines: string[];
  records(): LogRecord[];
} {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry, appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  return {
    logger,
    lines,
    records: () => lines.map((line) => JSON.parse(line) as LogRecord),
  };
}

// ---------------------------------------------------------------------------------------------
// The HTTP entry, loaded only when called (after tracing started, as the entries do).

export interface InjectResponse {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  json(): unknown;
}
export interface EntryApp {
  init(): Promise<unknown>;
  listen(port: number, host: string): Promise<unknown>;
  getHttpServer(): { address(): AddressInfo | string | null };
  inject(options: {
    method: string;
    url: string;
    headers?: Record<string, string>;
  }): Promise<InjectResponse>;
  close(): Promise<void>;
}
interface Bootstrap {
  createHttpApp(
    entry: 'api' | 'stream' | 'admin',
    overrides: { config: AppConfig; logger: RootLogger },
  ): Promise<EntryApp>;
}

// Computed import keeps Nest decorators in the API project's compiler context.
export async function createEntryApp(
  entry: 'api' | 'stream' | 'admin',
  config: AppConfig,
  logger: RootLogger,
): Promise<EntryApp> {
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as Bootstrap;
  return boot.createHttpApp(entry, { config, logger });
}

/** init + listen on a loopback port; returns the port (int tests only). */
export async function listenOn(app: EntryApp): Promise<number> {
  await app.init();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (address === null || typeof address === 'string') throw new Error('no TCP address');
  return address.port;
}

// ---------------------------------------------------------------------------------------------
// A raw HTTP/1.1 client over net: the test's own requests are not instrumented, so nothing is
// added to them (no traceparent / x-trace-id from the test side).

export interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function dechunk(body: string): string {
  let rest = body;
  let out = '';
  for (;;) {
    const lineEnd = rest.indexOf('\r\n');
    if (lineEnd === -1) return out;
    const size = Number.parseInt(rest.slice(0, lineEnd), 16);
    if (!Number.isFinite(size) || size === 0) return out;
    out += rest.slice(lineEnd + 2, lineEnd + 2 + size);
    rest = rest.slice(lineEnd + 2 + size + 2);
  }
}

export async function send(
  port: number,
  request: {
    readonly method?: string;
    readonly path: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  },
): Promise<RawResponse> {
  const body = request.body ?? '';
  const head = [
    `${request.method ?? 'GET'} ${request.path} HTTP/1.1`,
    `host: 127.0.0.1:${port}`,
    'connection: close',
    ...Object.entries(request.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    ...(body === '' ? [] : [`content-length: ${Buffer.byteLength(body)}`]),
  ].join('\r\n');
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => void chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks)));
    socket.on('error', reject);
    socket.setTimeout(10_000, () => socket.destroy(new Error('no response within 10 s')));
    socket.write(`${head}\r\n\r\n${body}`);
  });
  const text = raw.toString('utf8');
  const split = text.indexOf('\r\n\r\n');
  const [statusLine = '', ...headerLines] = text.slice(0, split).split('\r\n');
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const rawBody = text.slice(split + 4);
  return {
    status: Number(statusLine.split(' ')[1]),
    headers,
    body: headers['transfer-encoding'] === 'chunked' ? dechunk(rawBody) : rawBody,
  };
}

// ---------------------------------------------------------------------------------------------
// A small OTLP/HTTP trace receiver on the loopback: records every request body (JSON or
// protobuf, gzip / deflate undone) and decodes its spans.

export type ReceiverMode = 'ok' | 'fail' | 'hang';

export interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly contentType: string;
  /** The decoded (decompressed) body. */
  readonly body: Buffer;
}

export interface ReceivedSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string;
  readonly name: string;
  readonly kind: number;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly resource: Readonly<Record<string, unknown>>;
}

export interface Receiver {
  readonly url: string;
  /** ok: 200; fail: 500; hang: never answers. */
  mode: ReceiverMode;
  readonly requests: ReceivedRequest[];
  spans(): ReceivedSpan[];
  close(): Promise<void>;
}

export async function startReceiver(): Promise<Receiver> {
  const requests: ReceivedRequest[] = [];
  const state: { mode: ReceiverMode } = { mode: 'ok' };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => void chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const encoding = String(req.headers['content-encoding'] ?? '').toLowerCase();
      const body =
        encoding === 'gzip' ? gunzipSync(raw) : encoding === 'deflate' ? inflateSync(raw) : raw;
      const contentType = String(req.headers['content-type'] ?? '');
      requests.push({ method: req.method ?? '', path: req.url ?? '', contentType, body });
      if (state.mode === 'hang') return;
      const json = contentType.includes('json');
      res.statusCode = state.mode === 'fail' ? 500 : 200;
      res.setHeader('content-type', json ? 'application/json' : 'application/x-protobuf');
      res.end(json ? '{}' : Buffer.alloc(0));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/insert/opentelemetry/v1/traces`,
    get mode() {
      return state.mode;
    },
    set mode(mode: ReceiverMode) {
      state.mode = mode;
    },
    requests,
    spans: () => requests.flatMap(decodeExport),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A loopback URL on a port nothing listens on any more. */
export async function closedEndpoint(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/insert/opentelemetry/v1/traces`;
}

export function decodeExport(request: ReceivedRequest): ReceivedSpan[] {
  if (request.contentType.includes('json')) {
    return decodeJson(JSON.parse(request.body.toString('utf8')) as JsonExport);
  }
  if (request.contentType.includes('protobuf')) return decodeProtobuf(request.body);
  throw new Error(`OTLP receiver: unexpected content type ${request.contentType}`);
}

// OTLP JSON (ids as hex, or base64 as in proto3 JSON).
interface JsonAnyValue {
  readonly stringValue?: string;
  readonly boolValue?: boolean;
  readonly intValue?: string | number;
  readonly doubleValue?: number;
  readonly arrayValue?: { readonly values?: readonly JsonAnyValue[] };
  readonly kvlistValue?: { readonly values?: readonly JsonKeyValue[] };
  readonly bytesValue?: string;
}
interface JsonKeyValue {
  readonly key: string;
  readonly value?: JsonAnyValue;
}
interface JsonSpan {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly name?: string;
  readonly kind?: number | string;
  readonly attributes?: readonly JsonKeyValue[];
}
interface JsonExport {
  readonly resourceSpans?: readonly {
    readonly resource?: { readonly attributes?: readonly JsonKeyValue[] };
    readonly scopeSpans?: readonly { readonly spans?: readonly JsonSpan[] }[];
  }[];
}

const KIND_NAMES: Readonly<Record<string, number>> = {
  SPAN_KIND_INTERNAL: 1,
  SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3,
  SPAN_KIND_PRODUCER: 4,
  SPAN_KIND_CONSUMER: 5,
};

function jsonValue(value: JsonAnyValue | undefined): unknown {
  if (value === undefined) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.arrayValue !== undefined) return (value.arrayValue.values ?? []).map(jsonValue);
  if (value.kvlistValue !== undefined) return jsonAttributes(value.kvlistValue.values);
  return value.bytesValue;
}

function jsonAttributes(list: readonly JsonKeyValue[] | undefined): Record<string, unknown> {
  return Object.fromEntries((list ?? []).map((pair) => [pair.key, jsonValue(pair.value)]));
}

function idOf(value: string | undefined, hexLength: number): string {
  if (value === undefined || value === '') return '';
  if (value.length === hexLength && /^[0-9a-f]+$/i.test(value)) return value.toLowerCase();
  return Buffer.from(value, 'base64').toString('hex');
}

function decodeJson(document: JsonExport): ReceivedSpan[] {
  return (document.resourceSpans ?? []).flatMap((resourceSpans) => {
    const resource = jsonAttributes(resourceSpans.resource?.attributes);
    return (resourceSpans.scopeSpans ?? []).flatMap((scope) =>
      (scope.spans ?? []).map((span) => ({
        traceId: idOf(span.traceId, 32),
        spanId: idOf(span.spanId, 16),
        parentSpanId: idOf(span.parentSpanId, 16),
        name: span.name ?? '',
        kind: typeof span.kind === 'string' ? (KIND_NAMES[span.kind] ?? 0) : (span.kind ?? 0),
        attributes: jsonAttributes(span.attributes),
        resource,
      })),
    );
  });
}

// OTLP protobuf (opentelemetry/proto/collector/trace/v1), decoded by field number only.
interface ProtoField {
  readonly no: number;
  readonly wire: number;
  readonly varint: bigint;
  readonly bytes: Buffer;
}

function protoFields(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = 0;
  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = buffer[pos];
      if (byte === undefined) throw new Error('OTLP receiver: truncated varint');
      pos += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  };
  const take = (length: number): Buffer => {
    const bytes = buffer.subarray(pos, pos + length);
    pos += length;
    return bytes;
  };
  while (pos < buffer.length) {
    const key = Number(varint());
    const no = key >>> 3;
    const wire = key & 7;
    if (wire === 0) fields.push({ no, wire, varint: varint(), bytes: Buffer.alloc(0) });
    else if (wire === 1) fields.push({ no, wire, varint: 0n, bytes: take(8) });
    else if (wire === 2) fields.push({ no, wire, varint: 0n, bytes: take(Number(varint())) });
    else if (wire === 5) fields.push({ no, wire, varint: 0n, bytes: take(4) });
    else throw new Error(`OTLP receiver: unsupported wire type ${wire}`);
  }
  return fields;
}

function protoAnyValue(buffer: Buffer): unknown {
  for (const field of protoFields(buffer)) {
    if (field.no === 1) return field.bytes.toString('utf8');
    if (field.no === 2) return field.varint !== 0n;
    if (field.no === 3) return Number(BigInt.asIntN(64, field.varint));
    if (field.no === 4) return field.bytes.readDoubleLE(0);
    if (field.no === 5) {
      return protoFields(field.bytes)
        .filter((item) => item.no === 1)
        .map((item) => protoAnyValue(item.bytes));
    }
    if (field.no === 6) {
      return protoAttributes(protoFields(field.bytes).filter((item) => item.no === 1));
    }
    if (field.no === 7) return field.bytes.toString('hex');
  }
  return undefined;
}

function protoAttributes(list: readonly ProtoField[]): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const pair of list) {
    let key = '';
    let value: unknown;
    for (const field of protoFields(pair.bytes)) {
      if (field.no === 1) key = field.bytes.toString('utf8');
      if (field.no === 2) value = protoAnyValue(field.bytes);
    }
    attributes[key] = value;
  }
  return attributes;
}

function decodeProtobuf(body: Buffer): ReceivedSpan[] {
  const spans: ReceivedSpan[] = [];
  for (const resourceSpans of protoFields(body).filter((field) => field.no === 1)) {
    const parts = protoFields(resourceSpans.bytes);
    const resourceField = parts.find((field) => field.no === 1);
    const resource =
      resourceField === undefined
        ? {}
        : protoAttributes(protoFields(resourceField.bytes).filter((field) => field.no === 1));
    for (const scopeSpans of parts.filter((field) => field.no === 2)) {
      for (const spanField of protoFields(scopeSpans.bytes).filter((field) => field.no === 2)) {
        const span = protoFields(spanField.bytes);
        const bytesOf = (no: number): Buffer =>
          span.find((field) => field.no === no)?.bytes ?? Buffer.alloc(0);
        spans.push({
          traceId: bytesOf(1).toString('hex'),
          spanId: bytesOf(2).toString('hex'),
          parentSpanId: bytesOf(4).toString('hex'),
          name: bytesOf(5).toString('utf8'),
          kind: Number(span.find((field) => field.no === 6)?.varint ?? 0n),
          attributes: protoAttributes(span.filter((field) => field.no === 9)),
          resource,
        });
      }
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------------------------
// Waiting.

/** Polls `ready` every 50 ms for at most `limitMs`; true once it held. */
export async function waitFor(ready: () => boolean, limitMs: number): Promise<boolean> {
  const until = performance.now() + limitMs;
  while (!ready()) {
    if (performance.now() > until) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** How long a batch of spans may take to reach the receiver (batch delay + export). */
export const EXPORT_WAIT_MS = 20_000;

/** The value of the first of `names` present in `attributes` (old and stable semconv names). */
export function attributeOf(
  attributes: Readonly<Record<string, unknown>>,
  ...names: string[]
): unknown {
  for (const name of names) if (name in attributes) return attributes[name];
  return undefined;
}

/**
 * Runs `create` once, on first use, and hands every caller the same result: each test awaits the
 * setup itself, so a failing setup (NotImplemented) fails every test of the file.
 */
export function lazily<T>(create: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => (made ??= create());
}

/**
 * Starts a receiver and runs `rest` with it; when `rest` fails (tracing not started), the receiver
 * is closed before the error propagates, so a failed setup leaves no open port behind.
 */
export async function withReceiver<T>(rest: (receiver: Receiver) => Promise<T>): Promise<T> {
  const receiver = await startReceiver();
  try {
    return await rest(receiver);
  } catch (error) {
    await receiver.close();
    throw error;
  }
}
