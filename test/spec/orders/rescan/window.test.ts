// B1-04zm: pure rescan window arithmetic (规划/02 §7.1; D10-543).
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  rescanIntervalSeconds,
  rescanStep,
} from '../../../../apps/api/src/modules/orders/domain/sync-window.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, NOW_MS } from './kit.ts';

const FROM_30_DAYS = NOW_MS - 30 * DAY_MS;
const RESCAN_START_MARGIN_MS = HOUR_MS;

/** The range one round covers: it starts the margin after now − days. */
const rangeMs = (days: number): number => days * DAY_MS - RESCAN_START_MARGIN_MS;

interface Round {
  readonly windows: readonly { readonly startMs: number; readonly endMs: number }[];
  readonly restartMs: number;
}

/** One whole round with the clock held at `nowMs`; null when it never ends. */
function walk(nowMs: number, days: number, capMs: number): Round | null {
  const limit = Math.floor((days * DAY_MS) / capMs) + 1;
  const windows: { startMs: number; endMs: number }[] = [];
  let cursor: number | null = null;
  for (let step = 0; step <= limit; step += 1) {
    const next = rescanStep(cursor, nowMs, days, capMs);
    if (next.kind === 'round_end') return { windows, restartMs: next.restartMs };
    windows.push({ startMs: next.startMs, endMs: next.endMs });
    cursor = next.endMs;
  }
  return null;
}

/** Full windows, each starting where the last ended, from `fromMs`. */
function joined(round: Round, fromMs: number, capMs: number): boolean {
  return (
    round.restartMs === fromMs &&
    round.windows.length > 0 &&
    round.windows.every(
      (win, index) =>
        win.endMs - win.startMs === capMs &&
        win.startMs === (round.windows[index - 1]?.endMs ?? fromMs),
    )
  );
}

function coversRange(nowMs: number, days: number, capMs: number): boolean {
  const first = walk(nowMs, days, capMs);
  // The tail shorter than a window waits for the next round, which starts after the clock moved.
  const nextNowMs = nowMs + capMs;
  const next = walk(nextNowMs, days, capMs);
  if (first === null || next === null) return false;
  const fromMs = nowMs - rangeMs(days);
  const tailMs = first.windows.at(-1)?.endMs ?? fromMs;
  const nextEndMs = next.windows.at(-1)?.endMs ?? nowMs - 1;
  return (
    joined(first, fromMs, capMs) &&
    joined(next, nextNowMs - rangeMs(days), capMs) &&
    nowMs - tailMs >= 0 &&
    nowMs - tailMs < capMs &&
    (next.windows[0]?.startMs ?? Number.POSITIVE_INFINITY) <= tailMs &&
    nextEndMs >= nowMs
  );
}

// A round of at most about 32 windows keeps the default 10000 runs well inside the test timeout;
// the jd case of 720 windows has its own test below.
const cases = fc
  .record({
    minutes: fc.integer({ min: 0, max: 5_000_000 }),
    days: fc.integer({ min: 1, max: 90 }),
    pieces: fc.integer({ min: 1, max: 16 }),
    shrink: fc.integer({ min: 0, max: 999 }),
  })
  .map(({ minutes, days, pieces, shrink }) => {
    const even = Math.ceil(rangeMs(days) / pieces);
    return {
      nowMs: NOW_MS + minutes * MINUTE_MS,
      days,
      capMs: even - Math.floor((even * shrink) / 2000),
    };
  });

it.each([
  { days: 30, capMs: HOUR_MS, seconds: 120 },
  { days: 1, capMs: HOUR_MS, seconds: 3600 },
  { days: 1, capMs: DAY_MS, seconds: 86_400 },
  { days: 90, capMs: 2 * HOUR_MS, seconds: 80 },
  { days: 30, capMs: 30 * MINUTE_MS, seconds: 60 },
])(
  '[AC-B1-04zm#1] 间隔 = 24 小时 ÷ 一轮窗口数：$days 天 $capMs 毫秒窗是 $seconds 秒',
  ({ days, capMs, seconds }) => {
    expect(rescanIntervalSeconds(days, capMs)).toBe(seconds);
  },
);

it.each([
  { days: 90, capMs: 30 * MINUTE_MS },
  { days: 90, capMs: HOUR_MS },
  { days: 45, capMs: 30 * MINUTE_MS },
])('[AC-B1-04zm#2] 间隔下限 60 秒：$days 天 $capMs 毫秒窗', ({ days, capMs }) => {
  expect(rescanIntervalSeconds(days, capMs)).toBe(60);
});

it.each([
  { label: '游标为空', cursorMs: null, startMs: FROM_30_DAYS },
  { label: '游标早于 now − days', cursorMs: FROM_30_DAYS - 1, startMs: FROM_30_DAYS },
  { label: '游标等于 now − days', cursorMs: FROM_30_DAYS, startMs: FROM_30_DAYS },
  { label: '游标在范围内', cursorMs: FROM_30_DAYS + 5, startMs: FROM_30_DAYS + 5 },
  { label: '正好还剩一整窗', cursorMs: NOW_MS - HOUR_MS, startMs: NOW_MS - HOUR_MS },
])('[AC-B1-04zm#3] $label：发整窗', ({ cursorMs, startMs }) => {
  expect(rescanStep(cursorMs, NOW_MS, 30, HOUR_MS)).toEqual({
    kind: 'window',
    startMs,
    endMs: startMs + HOUR_MS,
  });
});

it.each([
  { label: '差 1 毫秒不足一窗', cursorMs: NOW_MS - HOUR_MS + 1 },
  { label: '游标等于 now', cursorMs: NOW_MS },
  { label: '游标晚于 now', cursorMs: NOW_MS + 1 },
])('[AC-B1-04zm#4] $label：本轮结束，回到 now − days', ({ cursorMs }) => {
  expect(rescanStep(cursorMs, NOW_MS, 30, HOUR_MS)).toEqual({
    kind: 'round_end',
    restartMs: FROM_30_DAYS,
  });
});

it('[AC-B1-04zm#5] 京东 30 天 60 分钟窗一轮正好 720 窗，首尾相接到 now', () => {
  const round = walk(NOW_MS, 30, HOUR_MS);
  expect(round?.windows).toHaveLength(720);
  expect(round?.windows.at(-1)?.endMs).toBe(NOW_MS);
  expect(round === null ? false : joined(round, FROM_30_DAYS, HOUR_MS)).toBe(true);
});

it('[AC-B1-04zm#6] 任意 days 与 cap：窗口不重不漏，尾段不足一窗时由下一轮补上，两轮覆盖 [now − days + 1 小时, now]', () => {
  expect(() =>
    fc.assert(
      fc.property(cases, ({ nowMs, days, capMs }) => coversRange(nowMs, days, capMs)),
      propParams(),
    ),
  ).not.toThrow();
});
