// OpenTelemetry export of the api / stream / worker entries to VictoriaTraces over OTLP/HTTP
// (B1-31; 规划/02 §13 链路行, 06 Q-A9). Traces are for troubleshooting only, never evidence for any
// money decision; exporting is fail-open (./export-health.ts).
import type { AppConfig } from '../config/index.ts';
import type { EntryName } from '../entries.ts';
import type { RootLogger } from '../logging/index.ts';

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

/**
 * Starts tracing for `entry` before http / pg / undici are first used. Enabled: a NodeTracerProvider
 * (registered globally) with AsyncLocalStorage context, a batch processor and the OTLP/HTTP exporter,
 * the propagator of ./trace-correlation.ts, and the http (inbound and outbound), pg and undici
 * instrumentations. Resource: service.name (OTEL_SERVICE_NAME, default `couli-<entry>`),
 * service.version (COULI_DEPLOY_VERSION, default 'dev'), deployment.environment (APP_ENV) and the
 * entry. Server spans also carry `couli.trace_id` (the request id) and `couli.entry`; span
 * attributes hold method, path and status code, never bodies, query strings or auth headers.
 * Disabled (admin, payout, or no endpoint): installs nothing at all and changes nothing.
 */
export function startTracing(options: TracingOptions): Promise<TracingHandle> {
  void options;
  throw new Error('NotImplemented: startTracing');
}
