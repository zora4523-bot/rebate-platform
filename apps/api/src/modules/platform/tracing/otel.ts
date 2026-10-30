// OpenTelemetry export of the api / stream / worker entries to VictoriaTraces over OTLP/HTTP
// (B1-31; 规划/02 §13 链路行, 06 Q-A9). Traces are for troubleshooting only, never evidence for any
// money decision; exporting is fail-open (./export-health.ts).
import { createRequire, register as registerLoaderHook, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Attributes, Span } from '@opentelemetry/api';
import type * as ContextAsyncHooks from '@opentelemetry/context-async-hooks';
import type * as ExporterOtlpHttp from '@opentelemetry/exporter-trace-otlp-http';
import type * as Instrumentation from '@opentelemetry/instrumentation';
import type * as InstrumentationHttp from '@opentelemetry/instrumentation-http';
import type * as InstrumentationPg from '@opentelemetry/instrumentation-pg';
import type * as InstrumentationUndici from '@opentelemetry/instrumentation-undici';
import type * as Resources from '@opentelemetry/resources';
import type * as SdkTrace from '@opentelemetry/sdk-trace';
import type { ReadableSpan, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace';
import { clockFromConfig } from '../clock/index.ts';
import type { AppConfig } from '../config/index.ts';
import type { EntryName } from '../entries.ts';
import type { RootLogger } from '../logging/index.ts';
import { createExportHealth } from './export-health.ts';
import { resolveTraceId } from './trace-id.ts';
import {
  TRACE_ID_HEADER,
  createTracePropagator,
  otel,
  requestIdFromTraceId,
} from './trace-correlation.ts';

// The SDK packages as their CommonJS builds (see `otel` in ./trace-correlation.ts): loaded lazily,
// only when tracing is enabled, so a disabled entry installs nothing and loads nothing.
const load = createRequire(import.meta.url);

const SEMCONV = '@opentelemetry/semantic-conventions';
let semconvPinned = false;

/**
 * @opentelemetry/semantic-conventions declares only "module" / "esnext" / "default" exports; a
 * resolver that honours "module" (a test runner's loader hooks do) hands Node its ESM build, whose
 * extension-less `export * from './trace'` Node refuses. The SDK and the instrumentations require
 * it, so before they load, both subpaths are pinned to the build Node itself would pick
 * ("default", build/src). Outside such a resolver the pin resolves to the same file.
 */
function pinSemconvResolution(): void {
  if (semconvPinned) return;
  semconvPinned = true;
  const resolved = load.resolve(SEMCONV);
  const index = pathToFileURL(
    resolved.replace(/([\\/])build[\\/](?:esm|esnext)([\\/])/, '$1build$2src$2'),
  ).href;
  const incubating = index.replace(/index\.js$/, 'index-incubating.js');
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === SEMCONV) return { url: index, format: 'commonjs', shortCircuit: true };
      if (specifier === `${SEMCONV}/incubating`) {
        return { url: incubating, format: 'commonjs', shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}
function sdk() {
  return {
    contextAsyncHooks: load('@opentelemetry/context-async-hooks') as typeof ContextAsyncHooks,
    exporter: load('@opentelemetry/exporter-trace-otlp-http') as typeof ExporterOtlpHttp,
    instrumentation: load('@opentelemetry/instrumentation') as typeof Instrumentation,
    http: load('@opentelemetry/instrumentation-http') as typeof InstrumentationHttp,
    pg: load('@opentelemetry/instrumentation-pg') as typeof InstrumentationPg,
    undici: load('@opentelemetry/instrumentation-undici') as typeof InstrumentationUndici,
    resources: load('@opentelemetry/resources') as typeof Resources,
    sdkTrace: load('@opentelemetry/sdk-trace') as typeof SdkTrace,
  };
}

export interface TracingOptions {
  readonly entry: EntryName;
  /** From loadConfig: the endpoint, sample ratio and service name are read here, never from process.env. */
  readonly config: AppConfig;
  readonly logger: RootLogger;
}

export interface TracingHandle {
  /** True only for api / stream / worker with OTEL_EXPORTER_OTLP_TRACES_ENDPOINT set. */
  readonly enabled: boolean;
  /** Flushes pending spans and stops exporting; waits at most 2 seconds; never rejects. */
  shutdown(): Promise<void>;
}

/** The entries that export traces (05 B1-31); admin and payout never do. */
const TRACED_ENTRIES: ReadonlySet<EntryName> = new Set<EntryName>(['api', 'stream', 'worker']);
/** shutdown() budget (task brief §9): flush, then stop, never longer. */
const SHUTDOWN_BUDGET_MS = 2_000;
/** One export call may not outlive the shutdown budget. */
const EXPORT_TIMEOUT_MS = 1_500;
const EXPORT_DELAY_MS = 500;
/** Span attributes that may carry query values or full URLs; the exporter never sees them. */
const URL_ATTRIBUTES = ['url.full', 'url.query', 'http.url', 'http.target'] as const;

const DISABLED: TracingHandle = Object.freeze({
  enabled: false,
  shutdown: () => Promise.resolve(),
});

/** The process's one enabled tracing (startTracing is idempotent while it is running). */
let active: TracingHandle | null = null;

/**
 * 02 §13 request id of an incoming request: the well-formed inbound X-Trace-Id as sent; else the
 * active server span's trace id as a UUID (tracing on: the response header, the log lines and the
 * exported span then name the same trace); else a random UUID (as before).
 */
export function requestIdForTrace(inbound: unknown): string {
  const resolved = resolveTraceId(inbound);
  if (resolved === inbound) return resolved;
  const spanContext = otel.trace.getActiveSpan()?.spanContext();
  const fromSpan =
    spanContext !== undefined && otel.trace.isSpanContextValid(spanContext)
      ? requestIdFromTraceId(spanContext.traceId)
      : null;
  return fromSpan ?? resolved;
}

/** Hands every export to the real exporter and counts the failures (fail-open). */
function countingExporter(
  inner: SpanExporter,
  recordFailure: (error: unknown) => void,
): SpanExporter {
  return {
    export(spans, resultCallback) {
      try {
        inner.export(spans, (result) => {
          // ExportResultCode.SUCCESS is 0.
          if (result.code !== 0) recordFailure(result.error ?? new Error('export_failed'));
          resultCallback(result);
        });
      } catch (error: unknown) {
        recordFailure(error);
        resultCallback({
          code: 1,
          error: error instanceof Error ? error : new Error('export_failed'),
        });
      }
    },
    shutdown: () => inner.shutdown(),
    forceFlush: () => (inner.forceFlush === undefined ? Promise.resolve() : inner.forceFlush()),
  };
}

/** Strips query values and full URLs before a span reaches the batch processor (AC-B1-31#10). */
function sanitizingProcessor(next: SpanProcessor): SpanProcessor {
  return {
    onStart: (span, parentContext) => next.onStart(span, parentContext),
    onEnd: (span: ReadableSpan) => {
      const attributes = span.attributes as Record<string, unknown>;
      const full = attributes['url.full'] ?? attributes['http.url'];
      if (typeof full === 'string' && attributes['url.path'] === undefined) {
        try {
          attributes['url.path'] = new URL(full).pathname;
        } catch {
          // Not a URL: nothing to keep.
        }
      }
      for (const key of URL_ATTRIBUTES) delete attributes[key];
      next.onEnd(span);
    },
    shutdown: () => next.shutdown(),
    forceFlush: () => next.forceFlush(),
  };
}

function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

let loaderHookRegistered = false;

/** The ESM loader hook of @opentelemetry/instrumentation: pg (CJS, imported from ESM) is patched through it. */
function registerEsmHook(logger: RootLogger): void {
  if (loaderHookRegistered) return;
  loaderHookRegistered = true;
  try {
    // Only pg (and its pool) go through the loader: everything else keeps Node's own resolution
    // (the hook's own resolver would stumble over packages whose "module" build Node cannot load).
    registerLoaderHook('@opentelemetry/instrumentation/hook.mjs', import.meta.url, {
      data: { include: ['pg', 'pg-pool'] },
    });
  } catch (error: unknown) {
    logger.warn(
      { error_name: error instanceof Error ? error.name : 'unknown' },
      'otel_loader_hook_failed',
    );
  }
}

/**
 * The process's running enabled tracing (the handle startTracing returned), or null when none is
 * running; never starts one (B1-31b: runEntry's failed startup flushes the tracing main.<entry>.ts
 * started through it).
 */
export function activeTracing(): TracingHandle | null {
  throw new Error('NotImplemented: activeTracing');
}

export function startTracing(options: TracingOptions): Promise<TracingHandle> {
  const { entry, config, logger } = options;
  if (active !== null) return Promise.resolve(active);
  const tracing = config.tracing;
  if (tracing === undefined || !TRACED_ENTRIES.has(entry)) return Promise.resolve(DISABLED);
  const clock = clockFromConfig(config);
  const health = createExportHealth({ logger, clock });
  pinSemconvResolution();
  registerEsmHook(logger);
  const {
    contextAsyncHooks: { AsyncLocalStorageContextManager },
    exporter: { OTLPTraceExporter },
    instrumentation: { registerInstrumentations },
    http: { HttpInstrumentation },
    pg: { PgInstrumentation },
    undici: { UndiciInstrumentation },
    resources: { resourceFromAttributes },
    sdkTrace: { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, TracerProvider },
  } = sdk();
  const { context: apiContext, propagation, trace } = otel;

  const resource = resourceFromAttributes({
    'service.name': tracing.serviceName ?? `couli-${entry}`,
    'service.version': config.deployVersion ?? 'dev',
    'deployment.environment': config.appEnv,
    'deployment.environment.name': config.appEnv,
    'couli.entry': entry,
  });
  const exporter = countingExporter(
    new OTLPTraceExporter({ url: tracing.endpoint, timeoutMillis: EXPORT_TIMEOUT_MS }),
    (error) => health.recordFailure(error),
  );
  const batch = new BatchSpanProcessor({
    exporter,
    scheduledDelayMillis: EXPORT_DELAY_MS,
    exportTimeoutMillis: EXPORT_TIMEOUT_MS,
  });
  const provider = new TracerProvider({
    resource,
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(tracing.sampleRatio) }),
    spanProcessors: [sanitizingProcessor(batch)],
  });
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  apiContext.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(createTracePropagator({ sampleRatio: tracing.sampleRatio }));
  trace.setGlobalTracerProvider(provider);

  /** The request id the entry will use (02 §13): the inbound X-Trace-Id as sent, else the trace id as a UUID. */
  const requestIdOf = (span: Span, inbound: unknown): string => {
    const adopted = typeof inbound === 'string' ? inbound : undefined;
    return adopted !== undefined && resolveTraceId(adopted) === adopted
      ? adopted
      : (requestIdFromTraceId(span.spanContext().traceId) ?? resolveTraceId(undefined));
  };
  const http = new HttpInstrumentation({
    requestHook: (span, request) => {
      if ('headers' in request && typeof request.headers === 'object' && request.headers !== null) {
        // Only incoming requests have `headers` with the inbound X-Trace-Id.
        const headers = request.headers as Record<string, unknown>;
        const base: Attributes = { 'couli.entry': entry };
        if ('method' in request) {
          base['couli.trace_id'] = requestIdOf(span, headers[TRACE_ID_HEADER]);
        }
        span.setAttributes(base);
      }
    },
  });
  const disableInstrumentations = registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      http,
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new UndiciInstrumentation(),
    ],
  });
  // The http instrumentation patches the core module when it is next required; require it now so
  // outbound node:http requests made from ESM code (the same module object) are traced at once.
  load('http');
  load('https');

  const handle: TracingHandle = {
    enabled: true,
    shutdown: async () => {
      if (active !== handle) return;
      active = null;
      try {
        await withTimeout(provider.shutdown(), SHUTDOWN_BUDGET_MS);
      } finally {
        try {
          disableInstrumentations();
        } catch {
          // Already disabled.
        }
        trace.disable();
        propagation.disable();
        apiContext.disable();
        contextManager.disable();
      }
    },
  };
  active = handle;
  logger.info(
    {
      entry,
      sample_ratio: tracing.sampleRatio,
      service_name: tracing.serviceName ?? `couli-${entry}`,
    },
    'otel_tracing_started',
  );
  return Promise.resolve(handle);
}
