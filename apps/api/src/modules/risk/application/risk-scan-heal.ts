// Self-heal timer of the risk-scan job chain (B1-03u, orchestrator ruling §9.3). While the worker
// runs, every RISK_SCAN_HEAL_INTERVAL_MS the assembled scan's heal() re-sends the next slot of
// both jobs (see ./risk-scan.ts): a healthy chain drops it through the exclusive key, a chain
// broken by a failed continuation resumes without a worker restart. Worker entry only; started
// after seedRiskScan, stopped on shutdown. The timer never keeps the process alive.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { RootLogger } from '../../platform/index.ts';
import { RISK_SCAN_QUEUE } from './risk-scan.ts';

/** B1-03u: the assembled RiskScan exposes this additional operation. */
export interface RiskScanHealer {
  heal(): Promise<void>;
}

export interface RiskScanHealControl {
  stop(): void;
}

/** Installs a recurring callback; stop cancels its timer. No immediate invocation. */
export type RiskScanHealSchedule = (
  tick: () => Promise<void>,
  intervalMs: number,
) => RiskScanHealControl;

/** Interval between two heals of the chain. */
export const RISK_SCAN_HEAL_INTERVAL_MS = 5 * 60_000;

const NO_HEAL: RiskScanHealControl = { stop: () => undefined };

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function isHealer(value: unknown): value is RiskScanHealer {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { heal?: unknown }).heal === 'function'
  );
}

/** setInterval, unref'd so the heal timer alone never keeps the process alive. */
const intervalSchedule: RiskScanHealSchedule = (tick, intervalMs) => {
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
};

/**
 * Worker-only lifecycle hook (entry.ts). `resolve` returns the provider of riskScanToken() (null
 * without a database). A stop already requested or no scan: no timer at all. Each tick skips
 * once a stop is requested or stop() was called (a tick already queued in the event loop too);
 * a rejected heal is a warn line and the next tick runs as usual.
 */
export function startRiskScanHeal(
  resolve: () => unknown,
  logger: RootLogger,
  stopping: () => boolean,
  schedule: RiskScanHealSchedule = intervalSchedule,
): RiskScanHealControl {
  if (stopping()) return NO_HEAL;
  let scan: unknown;
  try {
    scan = resolve();
  } catch (error) {
    logger.warn({ queue: RISK_SCAN_QUEUE, error_name: errorName(error) }, 'risk_scan_heal_failed');
    return NO_HEAL;
  }
  if (!isHealer(scan)) return NO_HEAL;
  const healer = scan;
  let stopped = false;
  const timer = schedule(async () => {
    if (stopped || stopping()) return;
    try {
      await healer.heal();
    } catch (error) {
      logger.warn(
        { queue: RISK_SCAN_QUEUE, error_name: errorName(error) },
        'risk_scan_heal_failed',
      );
    }
  }, RISK_SCAN_HEAL_INTERVAL_MS);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      timer.stop();
    },
  };
}
