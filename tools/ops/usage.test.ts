import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CLI_TIMEOUT, removeDir, runCli, scratchDir, writeFiles } from './test-helpers.ts';
import {
  buildCallLine,
  calibrate,
  gate,
  ledgerFile,
  parseLedger,
  readEvents,
  readLedger,
  recordCall,
  summarize,
  tierOf,
} from './usage.ts';
import type { CallLine, Ledger } from './usage.ts';

const NOW = new Date('2026-10-02T04:00:00.000Z'); // 12:00 in +08:00

function call(at: string, over: Partial<CallLine> = {}): CallLine {
  return {
    at,
    task: 'B2-01a',
    mode: 'impl',
    exit_code: 0,
    has_output: true,
    capacity_error: false,
    timed_out: false,
    input_tokens: 13_000,
    output_tokens: 2_000,
    thread_id: 't-1',
    ...over,
  };
}

const EVENTS = [
  '{"type":"thread.started","thread_id":"0199-abcd"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"Selected model is at capacity"}}',
  '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}',
  '{"type":"turn.started"}',
  '{"type":"turn.completed","usage":{"input_tokens":52000,"cached_input_tokens":39000,"output_tokens":3100}}',
  '{"type":"item.started","item":{"ty',
].join('\n');

let base = '';
let runs = '';

beforeAll(() => {
  base = scratchDir('usage');
  runs = join(base, 'runs');
  process.env.COULI_RUNS = runs;
});
afterAll(() => removeDir(base));

it('takes token usage from the last turn.completed event', () => {
  expect(readEvents(EVENTS)).toEqual({
    inputTokens: 52_000,
    outputTokens: 3_100,
    threadId: '0199-abcd',
    turnCompleted: true,
    // Quoted text inside an ordinary item is data, not a capacity error.
    capacityError: false,
  });
  const failed = '{"type":"turn.failed","error":{"message":"Selected model is at capacity"}}';
  expect(readEvents(failed)).toMatchObject({ turnCompleted: false, capacityError: true });
  expect(readEvents('', 'error: Selected model is at capacity\n').capacityError).toBe(true);
});

it('builds a ledger line from a run directory and appends it', () => {
  const run = join(base, 'run-ok');
  writeFiles(run, {
    'meta.json': JSON.stringify({ exit_code: 0 }),
    'events.jsonl': EVENTS,
    'err.txt': '',
    'impl.json': '{}',
  });
  expect(buildCallLine(run, 'B2-01a', 'impl', NOW)).toEqual({
    at: NOW.toISOString(),
    task: 'B2-01a',
    mode: 'impl',
    exit_code: 0,
    has_output: true,
    capacity_error: false,
    timed_out: false,
    input_tokens: 52_000,
    output_tokens: 3_100,
    thread_id: '0199-abcd',
  });

  const review = join(base, 'run-review');
  writeFiles(review, {
    'meta.json': JSON.stringify({ exit_code: 124, has_output: false, timed_out: true }),
    'review-events.jsonl': '{"type":"thread.started","thread_id":"0199-ffff"}\n',
  });
  expect(buildCallLine(review, 'B2-01a', 'review', NOW)).toMatchObject({
    mode: 'review',
    exit_code: 124,
    has_output: false,
    timed_out: true,
    input_tokens: 0,
    thread_id: '0199-ffff',
  });

  const capacity = join(base, 'run-capacity');
  writeFiles(capacity, {
    'meta.json': JSON.stringify({ exit_code: 1 }),
    'events.jsonl': '{"type":"error","message":"Selected model is at capacity"}\n',
  });
  expect(buildCallLine(capacity, 'B2-01a', 'impl', NOW)).toMatchObject({
    has_output: false,
    capacity_error: true,
  });

  expect(() => buildCallLine(join(base, 'missing'), 'B2-01a', 'impl', NOW)).toThrow(/meta.json/);
  expect(() => buildCallLine(run, 'B2-02a', 'review', NOW)).not.toThrow();
  // The per-mode copy wins over meta.json, which only describes the latest call.
  writeFiles(review, {
    'meta.json': JSON.stringify({ mode: 'impl', task: 'B2-01a', exit_code: 0 }),
    'meta.review.json': JSON.stringify({ mode: 'review', task: 'B2-01a', exit_code: 10 }),
  });
  expect(buildCallLine(review, 'B2-01a', 'review', NOW)).toMatchObject({ exit_code: 10 });
  expect(() => buildCallLine(review, 'B2-01a', 'impl', NOW)).not.toThrow();
  expect(() => buildCallLine(review, 'B2-09', 'review', NOW)).toThrow(
    /is for task B2-01a, not B2-09/,
  );
  writeFiles(review, { 'meta.impl.json': JSON.stringify({ mode: 'review', exit_code: 0 }) });
  expect(() => buildCallLine(review, 'B2-01a', 'impl', NOW)).toThrow(
    /is for mode review, not impl/,
  );

  recordCall(run, 'B2-01a', 'impl', NOW);
  recordCall(capacity, 'B2-01a', 'impl', NOW);
  const lines = readFileSync(ledgerFile(), 'utf8').trim().split('\n');
  expect(lines).toHaveLength(2);
  expect(Object.keys(JSON.parse(lines[0] ?? '{}') as object)).toEqual([
    'at',
    'task',
    'mode',
    'exit_code',
    'has_output',
    'capacity_error',
    'timed_out',
    'input_tokens',
    'output_tokens',
    'thread_id',
  ]);
  expect(readLedger().calls).toHaveLength(2);
});

it('rejects a damaged ledger instead of guessing', () => {
  expect(() => parseLedger('{"at":"2026-10-02T00:00:00Z","task":"X"}\n')).toThrow(
    /line 1: not a call line/,
  );
  expect(() => parseLedger('oops\n')).toThrow(/line 1: not JSON/);
  expect(parseLedger('\n')).toEqual({ calls: [], calibrations: [] });
});

it('counts calls per +08:00 day and per task, capacity errors included', () => {
  const ledger: Ledger = {
    calls: [
      call('2026-10-01T15:59:59.000Z'), // 23:59 yesterday in +08:00
      call('2026-10-01T16:00:00.000Z'), // 00:00 today
      call('2026-10-02T01:00:00.000Z', { task: 'B2-02a', capacity_error: true, has_output: false }),
      call('2026-10-02T02:00:00.000Z'),
    ],
    calibrations: [],
  };
  const s = summarize(ledger, NOW);
  expect(s.calls_today).toBe(3);
  expect(s.calls_by_task).toEqual({ 'B2-01a': 3, 'B2-02a': 1 });
});

it('counts consecutive calls without output and skips capacity errors', () => {
  const none = { has_output: false, exit_code: 1 };
  const ledger: Ledger = {
    calls: [
      call('2026-10-02T00:00:00.000Z'),
      call('2026-10-02T00:10:00.000Z', none),
      call('2026-10-02T00:20:00.000Z', { ...none, capacity_error: true }),
      call('2026-10-02T00:30:00.000Z', none),
    ],
    calibrations: [],
  };
  expect(summarize(ledger, NOW).consecutive_no_output).toBe(2);
  ledger.calls.push(call('2026-10-02T00:40:00.000Z', none));
  expect(summarize(ledger, NOW).consecutive_no_output).toBe(3);
  ledger.calls.push(call('2026-10-02T00:50:00.000Z'));
  expect(summarize(ledger, NOW).consecutive_no_output).toBe(0);
});

it('estimates the weekly percentage from calibrations and falls back to unknown', () => {
  expect(tierOf(null)).toBe('unknown');
  expect([tierOf(69.9), tierOf(70), tierOf(89.9), tierOf(90)]).toEqual([
    'normal',
    'reduced',
    'reduced',
    'stopped',
  ]);

  const never = summarize({ calls: [call('2026-10-02T03:00:00.000Z')], calibrations: [] }, NOW);
  expect(never).toMatchObject({ tier: 'unknown', estimated_weekly_percent: null, slope: 'none' });

  // One calibration: no slope, the estimate stays at the calibrated value.
  const one: Ledger = {
    calls: [call('2026-10-02T03:00:00.000Z')],
    calibrations: [{ at: '2026-10-02T02:00:00.000Z', weekly_used_percent: 40 }],
  };
  expect(summarize(one, NOW)).toMatchObject({
    tier: 'normal',
    estimated_weekly_percent: 40,
    tokens_since_calibration: 15_000,
    slope: 'none',
    calibration_age_hours: 2,
  });

  // Two calibrations: 150k of our tokens moved the quota by 10 points => 15k tokens per point.
  const two: Ledger = {
    calls: [
      ...Array.from({ length: 10 }, (_, i) => call(`2026-10-01T2${i % 4}:30:00.000Z`)),
      ...Array.from({ length: 30 }, () => call('2026-10-02T03:00:00.000Z')),
    ],
    calibrations: [
      { at: '2026-10-01T18:00:00.000Z', weekly_used_percent: 45 },
      { at: '2026-10-02T02:00:00.000Z', weekly_used_percent: 55 },
    ],
  };
  expect(summarize(two, NOW)).toMatchObject({
    slope: 'calibrations',
    tokens_since_calibration: 450_000,
    estimated_weekly_percent: 85,
    tier: 'reduced',
  });

  // quota.json wins over the derived slope.
  expect(summarize(two, NOW, { tokens_per_percent: 10_000 })).toMatchObject({
    slope: 'quota.json',
    estimated_weekly_percent: 100,
    tier: 'stopped',
  });

  // A calibration older than a day is not trusted.
  const stale = summarize(one, new Date('2026-10-03T02:00:01.000Z'));
  expect(stale).toMatchObject({ tier: 'unknown', estimated_weekly_percent: null });
  expect(
    summarize(one, new Date('2026-10-03T02:00:01.000Z'), { calibration_max_age_hours: 48 }).tier,
  ).toBe('normal');
});

it('opens a breaker for each limit and tells how to calibrate', () => {
  const calibrated = [{ at: '2026-10-02T03:00:00.000Z', weekly_used_percent: 10 }];
  const breakers = (ledger: Ledger, req = {}): string[] =>
    gate(summarize(ledger, NOW), req).reasons.map((r) => r.breaker);

  const quiet: Ledger = { calls: [call('2026-10-02T01:00:00.000Z')], calibrations: calibrated };
  expect(gate(summarize(quiet, NOW), { task: 'B2-01a' })).toMatchObject({
    allowed: true,
    reasons: [],
  });

  // 40 calls today, 10 of them capacity errors: the 41st is refused.
  const busy: Ledger = {
    calls: Array.from({ length: 40 }, (_, i) =>
      call('2026-10-02T01:00:00.000Z', {
        task: `T${i % 10}-01`,
        ...(i < 10 ? { capacity_error: true, has_output: false } : {}),
      }),
    ),
    calibrations: calibrated,
  };
  expect(breakers(busy)).toEqual(['daily_calls']);
  busy.calls.pop();
  expect(breakers(busy)).toEqual([]);

  const sameTask: Ledger = {
    calls: Array.from({ length: 6 }, () => call('2026-09-30T01:00:00.000Z')),
    calibrations: calibrated,
  };
  expect(breakers(sameTask, { task: 'B2-01a' })).toEqual(['task_calls']);
  expect(breakers(sameTask, { task: 'B2-02a' })).toEqual([]);

  const silent: Ledger = {
    calls: Array.from({ length: 3 }, () => call('2026-10-02T01:00:00.000Z', { has_output: false })),
    calibrations: calibrated,
  };
  expect(breakers(silent)).toEqual(['no_output']);

  const stopped: Ledger = {
    calls: [],
    calibrations: [{ at: '2026-10-02T03:00:00.000Z', weekly_used_percent: 90 }],
  };
  expect(breakers(stopped)).toEqual(['quota_stopped']);

  const reduced: Ledger = {
    calls: [],
    calibrations: [{ at: '2026-10-02T03:00:00.000Z', weekly_used_percent: 75 }],
  };
  expect(breakers(reduced)).toEqual([]);
  expect(breakers(reduced, { mode: 'impl', risk: 'RV1' })).toEqual(['quota_reduced']);
  expect(breakers(reduced, { mode: 'impl', risk: 'RV2' })).toEqual([]);
  expect(breakers(reduced, { mode: 'review', risk: 'RV0' })).toEqual([]);

  const unknown = gate(summarize({ calls: [], calibrations: [] }, NOW));
  expect(unknown.allowed).toBe(false);
  expect(unknown.reasons[0]?.breaker).toBe('quota_unknown');
  expect(unknown.reasons[0]?.message).toContain('usage.ts calibrate --weekly-used-percent');
});

it(
  'fails closed on the command line until a calibration is recorded',
  () => {
    const cliRuns = join(base, 'cli-runs');
    mkdirSync(cliRuns, { recursive: true });
    const env = { COULI_RUNS: cliRuns };
    const closed = runCli('usage.ts', ['gate', '--task', 'B2-01a'], env);
    expect(closed.status).toBe(3);
    expect(JSON.parse(closed.stdout)).toMatchObject({
      allowed: false,
      reasons: [{ breaker: 'quota_unknown' }],
    });

    expect(runCli('usage.ts', ['calibrate', '--weekly-used-percent', '12.5'], env).status).toBe(0);
    expect(runCli('usage.ts', ['gate', '--task', 'B2-01a'], env).status).toBe(0);

    const run = join(base, 'cli-run');
    writeFiles(run, { 'meta.json': '{"exit_code":1}', 'events.jsonl': '' });
    for (let i = 0; i < 3; i += 1) {
      expect(
        runCli('usage.ts', ['record', '--run', run, '--task', 'B2-01a', '--mode', 'impl'], env)
          .status,
      ).toBe(0);
    }
    const open = runCli('usage.ts', ['gate'], env);
    expect(open.status).toBe(3);
    expect(open.stderr).toContain('连续 3 次调用没有产出');

    const summary = JSON.parse(runCli('usage.ts', ['summary', '--json'], env).stdout) as Record<
      string,
      unknown
    >;
    expect(summary).toMatchObject({
      calls_today: 3,
      calls_by_task: { 'B2-01a': 3 },
      consecutive_no_output: 3,
      tier: 'normal',
      estimated_weekly_percent: 12.5,
    });
    expect(runCli('usage.ts', ['summary'], env).stdout).toContain('额度档位：normal');

    expect(runCli('usage.ts', ['calibrate', '--weekly-used-percent', 'lots'], env).status).toBe(2);
    expect(runCli('usage.ts', ['record', '--run', run, '--task', 'B2-01a'], env).status).toBe(2);
    writeFileSync(join(cliRuns, 'usage.jsonl'), 'garbage\n', { flag: 'a' });
    expect(runCli('usage.ts', ['gate'], env).status).toBe(2);
  },
  CLI_TIMEOUT,
);

it('calibrate validates the range', () => {
  expect(() => calibrate(101, NOW)).toThrow(/between 0 and 100/);
  expect(calibrate(33, NOW)).toEqual({ at: NOW.toISOString(), weekly_used_percent: 33 });
});
