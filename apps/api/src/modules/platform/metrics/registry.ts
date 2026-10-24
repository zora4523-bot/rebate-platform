// Prometheus registry of one entry (B1-01zzh): process-level metrics everywhere; the five business
// gauges only on the worker, filled by `collect` at scrape time (no polling loop).
// The text exposition format 0.0.4 is written here from Node built-ins only: the client library
// cannot be loaded in the test environment (its @opentelemetry/api dependency resolves to an ESM
// build Node cannot import), so no third-party metrics library is used at runtime.
import { performance } from 'node:perf_hooks';
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

/** Prometheus text exposition format 0.0.4. */
const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

interface Family {
  readonly name: string;
  readonly help: string;
  readonly type: 'gauge' | 'counter';
  readonly samples: readonly { readonly labels?: Record<string, string>; readonly value: number }[];
}

/** The five business gauges: snapshot key → metric name, help text and its one label. */
const BUSINESS_GAUGES: Readonly<
  Record<keyof WorkerMetricsSnapshot, { name: string; help: string; label: string }>
> = {
  queueFailed: {
    name: 'couli_queue_failed_jobs',
    help: 'Jobs in state failed, per queue (dead letter queues included).',
    label: 'queue',
  },
  deadLetters: {
    name: 'couli_queue_dead_letters',
    help: 'Jobs waiting in a dead letter queue (state created or retry).',
    label: 'queue',
  },
  backlog: {
    name: 'couli_queue_backlog_jobs',
    help: 'Jobs in state created that are due (start_after at or before now), per business queue.',
    label: 'queue',
  },
  oldestDueEvtAgeSeconds: {
    name: 'couli_evt_oldest_due_created_age_seconds',
    help: 'Age in seconds of the oldest due created job of each evt.* queue; 0 when none.',
    label: 'queue',
  },
  syncWatermarkLagSeconds: {
    name: 'couli_sync_watermark_lag_seconds',
    help: 'Seconds between now and the oldest sync cursor of each platform.',
    label: 'platform',
  },
};

const BUSINESS_KEYS = Object.keys(BUSINESS_GAUGES) as (keyof WorkerMetricsSnapshot)[];

function escapeHelp(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function escapeLabelValue(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

function renderFamily(family: Family): string {
  let out = `# HELP ${family.name} ${escapeHelp(family.help)}\n# TYPE ${family.name} ${family.type}\n`;
  for (const sample of family.samples) {
    const pairs = Object.entries(sample.labels ?? {}).map(
      ([key, value]) => `${key}="${escapeLabelValue(value)}"`,
    );
    const labels = pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
    out += `${family.name}${labels} ${formatValue(sample.value)}\n`;
  }
  return out;
}

/** The process-level metrics, under the names the standard Node.js client exports. */
function processFamilies(): Family[] {
  const cpu = process.cpuUsage();
  const user = cpu.user / 1e6;
  const system = cpu.system / 1e6;
  const memory = process.memoryUsage();
  return [
    {
      name: 'process_cpu_user_seconds_total',
      help: 'Total user CPU time spent in seconds.',
      type: 'counter',
      samples: [{ value: user }],
    },
    {
      name: 'process_cpu_system_seconds_total',
      help: 'Total system CPU time spent in seconds.',
      type: 'counter',
      samples: [{ value: system }],
    },
    {
      name: 'process_cpu_seconds_total',
      help: 'Total user and system CPU time spent in seconds.',
      type: 'counter',
      samples: [{ value: user + system }],
    },
    {
      name: 'process_resident_memory_bytes',
      help: 'Resident memory size in bytes.',
      type: 'gauge',
      samples: [{ value: memory.rss }],
    },
    {
      name: 'process_start_time_seconds',
      help: 'Start time of the process since unix epoch in seconds.',
      type: 'gauge',
      // The process's own start instant (not a business clock reading).
      samples: [{ value: Math.round(performance.timeOrigin / 1000) }],
    },
    {
      name: 'nodejs_heap_size_total_bytes',
      help: 'Process heap size from Node.js in bytes.',
      type: 'gauge',
      samples: [{ value: memory.heapTotal }],
    },
    {
      name: 'nodejs_heap_size_used_bytes',
      help: 'Process heap size used from Node.js in bytes.',
      type: 'gauge',
      samples: [{ value: memory.heapUsed }],
    },
  ];
}

function businessFamilies(snapshot: WorkerMetricsSnapshot): Family[] {
  return BUSINESS_KEYS.map((key) => {
    const { name, help, label } = BUSINESS_GAUGES[key];
    // Only this snapshot's series: one that disappeared does not keep its previous value.
    const samples = Object.entries(snapshot[key]).map(([value, sample]) => ({
      labels: { [label]: value },
      value: sample,
    }));
    return { name, help, type: 'gauge' as const, samples };
  });
}

export function createMetricsRegistry(options: MetricsRegistryOptions): MetricsRegistry {
  const collect = options.entry === 'worker' ? options.collect : undefined;
  return {
    contentType: CONTENT_TYPE,
    async render() {
      // Business values first, then the process values of the same scrape.
      const business = collect === undefined ? [] : businessFamilies(await collect());
      return [...business, ...processFamilies()].map(renderFamily).join('');
    },
  };
}
