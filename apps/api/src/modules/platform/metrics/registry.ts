// Prometheus registry of one entry (B1-01zzh): process-level default metrics everywhere; the five
// business gauges only on the worker, filled by `collect` at scrape time (no polling loop).
import type { EntryName } from '../entries.ts';
import type { WorkerMetricsSnapshot } from './collect.ts';

export interface MetricsRegistryOptions {
  readonly entry: EntryName;
  /** Used only when entry is 'worker'; called once per render(). */
  readonly collect?: () => Promise<WorkerMetricsSnapshot>;
}

export interface MetricsRegistry {
  /** Content-Type of render()'s text (Prometheus text exposition format). */
  readonly contentType: string;
  /** Every registered metric in the Prometheus text exposition format. */
  render(): Promise<string>;
}

export function createMetricsRegistry(options: MetricsRegistryOptions): MetricsRegistry {
  void options;
  throw new Error('NotImplemented: createMetricsRegistry');
}
