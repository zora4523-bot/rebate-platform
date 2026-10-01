// Harness check only: proves the rule-test workspace can load the funds packages from source
// (export condition `couli-src`, no prior build) and that PROP_RUNS / PROP_SEED /
// PROP_STATS_FILE are honoured end to end. It contains no business rule; real property tests
// are added next to this file by the test author (规划/11 §4.2).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as domain from '@couli/domain';
import * as money from '@couli/money';
import { createPropStats, propParams, propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { afterEach, expect, it, vi } from 'vitest';

const TWO_POW_31 = 2n ** 31n;
const INT64_MAX = 2n ** 63n - 1n;

// Amount bases must cover 0, 1, odd values and values above 2^31 (规划/11 §4.2).
const amountBase = fc.oneof(
  { arbitrary: fc.constant(0n), weight: 1 },
  { arbitrary: fc.constant(1n), weight: 1 },
  { arbitrary: fc.bigInt({ min: 2n, max: TWO_POW_31 }), weight: 4 },
  { arbitrary: fc.bigInt({ min: TWO_POW_31 + 1n, max: INT64_MAX }), weight: 4 },
);

function bucketOf(value: bigint): string {
  if (value === 0n) return 'zero';
  if (value === 1n) return 'one';
  if (value > TWO_POW_31) return 'gt_2_31';
  return value % 2n === 1n ? 'odd' : 'even';
}

afterEach(() => {
  vi.unstubAllEnvs();
});

it('resolves the funds packages from source through the couli-src condition', () => {
  expect(import.meta.resolve('@couli/money')).toMatch(/\/packages\/money\/src\/index\.ts$/);
  expect(import.meta.resolve('@couli/domain')).toMatch(/\/packages\/domain\/src\/index\.ts$/);
  expect(import.meta.resolve('@couli/testing')).toMatch(/\/packages\/testing\/src\/index\.ts$/);
  // Both packages are still empty shells (规划/11 §9.2).
  expect(Object.keys(money)).toEqual([]);
  expect(Object.keys(domain)).toEqual([]);
});

it('runs a property PROP_RUNS times with PROP_SEED and writes generator stats to PROP_STATS_FILE', () => {
  const external = process.env['PROP_STATS_FILE'];
  const scratch =
    external === undefined || external === ''
      ? mkdtempSync(join(tmpdir(), 'couli-harness-'))
      : undefined;
  const file = scratch === undefined ? (external as string) : join(scratch, 'stats.jsonl');
  vi.stubEnv('PROP_STATS_FILE', file);
  try {
    const name = 'harness:amount-base-buckets';
    const stats = createPropStats(name);
    let executed = 0;
    fc.assert(
      fc.property(amountBase, (value) => {
        executed += 1;
        stats.hit(bucketOf(value));
        return value >= 0n && value <= INT64_MAX;
      }),
      propParams(),
    );
    const record = stats.flush();
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    const written = JSON.parse(lines[lines.length - 1] ?? '') as unknown;
    const onePercent = propRuns() / 100;
    const hits = record.hits;
    const hitTotal = Object.values(hits).reduce((sum, count) => sum + count, 0);
    expect({
      executed,
      hitTotal,
      written,
      // With fewer than 1000 runs the 1% floor is not meaningful; the default tier uses 10000.
      zero: propRuns() < 1000 || (hits['zero'] ?? 0) >= onePercent,
      one: propRuns() < 1000 || (hits['one'] ?? 0) >= onePercent,
      odd: propRuns() < 1000 || (hits['odd'] ?? 0) >= onePercent,
      gt_2_31: propRuns() < 1000 || (hits['gt_2_31'] ?? 0) >= onePercent,
    }).toEqual({
      executed: propRuns(),
      hitTotal: propRuns(),
      written: { name, num_runs: propRuns(), seed: propSeed(), discards: 0, hits },
      zero: true,
      one: true,
      odd: true,
      gt_2_31: true,
    });
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
});

it('is reproducible: the same PROP_SEED yields the same generated values', () => {
  const draw = (seed: number): bigint[] => fc.sample(amountBase, { numRuns: 200, seed });
  const first = draw(propSeed());
  expect(first).toHaveLength(200);
  expect(draw(propSeed())).toEqual(first);
  expect(draw(propSeed() + 1)).not.toEqual(first);
});

it('rejects a malformed PROP_RUNS instead of silently running the default', () => {
  vi.stubEnv('PROP_RUNS', '1e6');
  expect(() => propParams()).toThrow(/PROP_RUNS/);
});
