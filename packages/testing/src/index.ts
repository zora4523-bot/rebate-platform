// Shared helpers for rule and property tests (protected path class 1, 规划/11 §4.4).
// Property-test run count and seed come from the environment only (规划/11 §4.2):
//   PROP_RUNS        runs per property, positive integer, default 10000
//   PROP_SEED        fast-check seed, integer, default 20261001
//   PROP_STATS_FILE  when set, generator statistics are appended to this file as JSON lines
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_PROP_RUNS = 10_000;
export const DEFAULT_PROP_SEED = 20261001;

function readIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name} must be a base-10 integer, got ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} is outside the safe integer range: ${raw}`);
  }
  return value;
}

/** Runs per property (PROP_RUNS, default 10000). Throws unless it is a positive integer. */
export function propRuns(): number {
  const runs = readIntegerEnv('PROP_RUNS', DEFAULT_PROP_RUNS);
  if (runs < 1) throw new Error(`PROP_RUNS must be a positive integer, got ${runs}`);
  return runs;
}

/** fast-check seed (PROP_SEED, default 20261001). */
export function propSeed(): number {
  return readIntegerEnv('PROP_SEED', DEFAULT_PROP_SEED);
}

/** Parameters to pass to `fc.assert` / `fc.check` / `fc.sample`. */
export function propParams(): { numRuns: number; seed: number } {
  return { numRuns: propRuns(), seed: propSeed() };
}

export interface PropStatsRecord {
  /** Property name given to `createPropStats`. */
  name: string;
  /** PROP_RUNS in effect when the record was flushed. */
  num_runs: number;
  /** PROP_SEED in effect when the record was flushed. */
  seed: number;
  /** Number of generated values rejected by a precondition (`fc.pre`). */
  discards: number;
  /** Hit count per bucket, keys sorted. */
  hits: Record<string, number>;
}

export interface PropStats {
  /** Count one generated value falling into `bucket`. */
  hit(bucket: string): void;
  /** Count one generated value rejected by a precondition. */
  discard(): void;
  /**
   * Returns the record, appends it as one JSON line to PROP_STATS_FILE when that variable is
   * set, and resets the counters. Never writes to the console (规划/11 §4.2).
   */
  flush(): PropStatsRecord;
}

export function createPropStats(name: string): PropStats {
  if (name === '') throw new Error('createPropStats: name must not be empty');
  let hits = new Map<string, number>();
  let discards = 0;
  return {
    hit(bucket: string): void {
      hits.set(bucket, (hits.get(bucket) ?? 0) + 1);
    },
    discard(): void {
      discards += 1;
    },
    flush(): PropStatsRecord {
      const sorted: Record<string, number> = {};
      for (const key of [...hits.keys()].sort()) sorted[key] = hits.get(key) ?? 0;
      const record: PropStatsRecord = {
        name,
        num_runs: propRuns(),
        seed: propSeed(),
        discards,
        hits: sorted,
      };
      const file = process.env['PROP_STATS_FILE'];
      if (file !== undefined && file !== '') {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify(record)}\n`);
      }
      hits = new Map();
      discards = 0;
      return record;
    },
  };
}
