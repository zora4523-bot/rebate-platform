export { resolveTraceId } from './trace-id.ts';
export {
  TRACE_ID_HEADER,
  TRACEPARENT_HEADER,
  createTracePropagator,
  requestIdFromTraceId,
  traceIdFromRequestId,
} from './trace-correlation.ts';
export type { TracePropagatorOptions } from './trace-correlation.ts';
export { requestIdForTrace, startTracing } from './otel.ts';
export type { TracingHandle, TracingOptions } from './otel.ts';
export { bootTracing } from './boot.ts';
export { createExportHealth } from './export-health.ts';
export type { ExportHealth, ExportHealthOptions } from './export-health.ts';
