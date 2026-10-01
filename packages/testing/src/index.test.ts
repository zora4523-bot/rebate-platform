import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROP_RUNS,
  DEFAULT_PROP_SEED,
  createPropStats,
  propParams,
  propRuns,
  propSeed,
} from './index.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

function clearPropEnv(): void {
  vi.stubEnv('PROP_RUNS', undefined);
  vi.stubEnv('PROP_SEED', undefined);
  vi.stubEnv('PROP_STATS_FILE', undefined);
}

it('falls back to the documented defaults when the variables are unset or empty', () => {
  clearPropEnv();
  expect(propRuns()).toBe(DEFAULT_PROP_RUNS);
  expect(propSeed()).toBe(DEFAULT_PROP_SEED);
  expect(propParams()).toEqual({ numRuns: 10_000, seed: 20261001 });
  vi.stubEnv('PROP_RUNS', '');
  vi.stubEnv('PROP_SEED', '');
  expect(propParams()).toEqual({ numRuns: 10_000, seed: 20261001 });
});

it('reads PROP_RUNS and PROP_SEED from the environment on every call', () => {
  clearPropEnv();
  vi.stubEnv('PROP_RUNS', '1000000');
  vi.stubEnv('PROP_SEED', '-42');
  expect(propParams()).toEqual({ numRuns: 1_000_000, seed: -42 });
  vi.stubEnv('PROP_RUNS', '7');
  expect(propRuns()).toBe(7);
});

it.each(['0', '-1', '1.5', '1e3', 'abc', ' 10', '0x10', '99999999999999999999'])(
  'rejects PROP_RUNS=%s',
  (raw) => {
    clearPropEnv();
    vi.stubEnv('PROP_RUNS', raw);
    expect(() => propRuns()).toThrow(/PROP_RUNS/);
  },
);

it.each(['1.5', 'seed', '0x1f', '99999999999999999999'])('rejects PROP_SEED=%s', (raw) => {
  clearPropEnv();
  vi.stubEnv('PROP_SEED', raw);
  expect(() => propSeed()).toThrow(/PROP_SEED/);
});

it('propParams drives fast-check: exact run count and reproducible values', () => {
  clearPropEnv();
  vi.stubEnv('PROP_RUNS', '250');
  vi.stubEnv('PROP_SEED', '12345');
  const seen: bigint[][] = [[], []];
  for (const bucket of seen) {
    fc.assert(
      fc.property(fc.bigInt(), (value) => {
        bucket.push(value);
        return true;
      }),
      propParams(),
    );
  }
  expect(seen[0]).toHaveLength(250);
  expect(seen[1]).toEqual(seen[0]);
});

it('stats recorder counts hits and discards and resets on flush without a stats file', () => {
  clearPropEnv();
  vi.stubEnv('PROP_RUNS', '3');
  const stats = createPropStats('unit:no-file');
  stats.hit('zero');
  stats.hit('odd');
  stats.hit('odd');
  stats.discard();
  expect(stats.flush()).toEqual({
    name: 'unit:no-file',
    num_runs: 3,
    seed: DEFAULT_PROP_SEED,
    discards: 1,
    hits: { odd: 2, zero: 1 },
  });
  expect(stats.flush()).toMatchObject({ discards: 0, hits: {} });
});

it('appends one JSON line per flush to PROP_STATS_FILE, creating parent directories', () => {
  clearPropEnv();
  const dir = mkdtempSync(join(tmpdir(), 'couli-prop-stats-'));
  try {
    const file = join(dir, 'nested', 'stats.jsonl');
    vi.stubEnv('PROP_STATS_FILE', file);
    const first = createPropStats('unit:first');
    first.hit('gt_2_31');
    first.flush();
    const second = createPropStats('unit:second');
    second.discard();
    second.flush();
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { name: 'unit:first', num_runs: 10_000, seed: 20261001, discards: 0, hits: { gt_2_31: 1 } },
      { name: 'unit:second', num_runs: 10_000, seed: 20261001, discards: 1, hits: {} },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('rejects an empty stats name', () => {
  expect(() => createPropStats('')).toThrow(/name/);
});
