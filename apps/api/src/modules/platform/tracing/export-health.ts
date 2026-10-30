// Fail-open bookkeeping of the trace exporter (B1-31). Traces are for troubleshooting only and never
// decide anything about money: a failed export is counted and reported at most once a minute, and
// never reaches a request or a job.
import type { Clock } from '../clock/index.ts';
import type { RootLogger } from '../logging/index.ts';

export interface ExportHealthOptions {
  readonly logger: RootLogger;
  /** Time source of the once-a-minute limit. */
  readonly clock: Clock;
}

export interface ExportHealth {
  /**
   * Counts one failed export. Logs `warn` `otel_export_failed` with `error_name` (the error's name,
   * never its message or stack) and `count` (failures so far, this one included) when no such
   * line was logged in the last 60 seconds. Never throws, even when the logger does.
   */
  recordFailure(error: unknown): void;
  /** Failed exports counted so far. */
  failures(): number;
}

const WARN_INTERVAL_MS = 60_000;

export function createExportHealth(options: ExportHealthOptions): ExportHealth {
  const { logger, clock } = options;
  let failures = 0;
  let lastWarnAt: number | null = null;
  return {
    recordFailure(error: unknown): void {
      failures += 1;
      try {
        const now = clock.now().getTime();
        if (lastWarnAt !== null && now - lastWarnAt < WARN_INTERVAL_MS) return;
        lastWarnAt = now;
        const errorName =
          error instanceof Error && error.name !== ''
            ? error.name
            : typeof error === 'string'
              ? 'Error'
              : 'Error';
        logger.warn({ error_name: errorName, count: failures }, 'otel_export_failed');
      } catch {
        // Fail-open: a logger (or clock) that throws must not reach the exporter's caller.
      }
    },
    failures: () => failures,
  };
}
