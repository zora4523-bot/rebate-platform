import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CLI_TIMEOUT, removeDir, runCli, scratchDir, writeFiles } from './test-helpers.ts';
import {
  buildCallLine,
  ledgerFile,
  parseLedger,
  readEvents,
  readLedger,
  recordCall,
  summarize,
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

it('skips damaged lines and the calibration lines of the removed quota gate', () => {
  const good = JSON.stringify(call('2026-10-02T00:00:00.000Z'));
  const ledger = parseLedger(
    [
      '{"at":"2026-10-02T00:00:00Z","task":"X"}',
      'oops',
      '{"at":"2026-10-01T00:00:00Z","weekly_used_percent":40}',
      good,
      '',
    ].join('\n'),
  );
  expect(ledger.skipped).toBe(2);
  expect(ledger.calls).toEqual([call('2026-10-02T00:00:00.000Z')]);
  expect(parseLedger('\n')).toEqual({ calls: [], skipped: 0 });
});

it('counts calls and tokens per +08:00 day and per task, capacity errors included', () => {
  const ledger: Ledger = {
    calls: [
      call('2026-10-01T15:59:59.000Z'), // 23:59 yesterday in +08:00
      call('2026-10-01T16:00:00.000Z'), // 00:00 today
      call('2026-10-02T01:00:00.000Z', {
        task: 'B2-02a',
        capacity_error: true,
        has_output: false,
        input_tokens: 0,
        output_tokens: 0,
      }),
      call('2026-10-02T02:00:00.000Z'),
    ],
    skipped: 1,
  };
  expect(summarize(ledger, NOW)).toEqual({
    at: NOW.toISOString(),
    calls_today: 3,
    tokens_today: 30_000,
    calls_by_task: { 'B2-01a': 3, 'B2-02a': 1 },
    tokens_by_task: { 'B2-01a': 45_000, 'B2-02a': 0 },
    skipped_lines: 1,
  });
});

it('has no quota limits: no tier, no daily cap, no gate', () => {
  // 规划/11 §1.3, owner 2026-10-02 (ops/approvals.yaml id 15): the Codex quota is unlimited.
  // 200 calls in one day are just counted.
  const busy: Ledger = {
    calls: Array.from({ length: 200 }, () => call('2026-10-02T01:00:00.000Z')),
    skipped: 0,
  };
  const s = summarize(busy, NOW) as Record<string, unknown>;
  expect(s['calls_today']).toBe(200);
  for (const gone of [
    'tier',
    'estimated_weekly_percent',
    'last_calibration',
    'consecutive_no_output',
  ]) {
    expect(s).not.toHaveProperty(gone);
  }
});

it(
  'records and summarises on the command line; gate and calibrate are gone',
  () => {
    const cliRuns = join(base, 'cli-runs');
    mkdirSync(cliRuns, { recursive: true });
    const env = { COULI_RUNS: cliRuns };

    // The removed quota commands are usage errors now: nothing may wait on them.
    const gateRes = runCli('usage.ts', ['gate', '--task', 'B2-01a'], env);
    expect(gateRes.status).toBe(2);
    expect(gateRes.stderr).toContain('expected: record | summary');
    expect(runCli('usage.ts', ['calibrate', '--weekly-used-percent', '12.5'], env).status).toBe(2);

    const run = join(base, 'cli-run');
    writeFiles(run, { 'meta.json': '{"exit_code":1}', 'events.jsonl': '' });
    for (let i = 0; i < 3; i += 1) {
      expect(
        runCli('usage.ts', ['record', '--run', run, '--task', 'B2-01a', '--mode', 'impl'], env)
          .status,
      ).toBe(0);
    }
    writeFileSync(join(cliRuns, 'usage.jsonl'), 'garbage\n', { flag: 'a' });

    const summary = JSON.parse(runCli('usage.ts', ['summary', '--json'], env).stdout) as Record<
      string,
      unknown
    >;
    expect(summary).toMatchObject({
      calls_by_task: { 'B2-01a': 3 },
      tokens_by_task: { 'B2-01a': 0 },
      skipped_lines: 1,
    });
    const text = runCli('usage.ts', ['summary'], env).stdout;
    expect(text).toContain('只记账，不设上限');
    expect(text).toContain('B2-01a=3 次 / 0 token');
    expect(text).toContain('账本里有 1 行读不出，已跳过');

    expect(runCli('usage.ts', ['record', '--run', run, '--task', 'B2-01a'], env).status).toBe(2);
  },
  CLI_TIMEOUT,
);
