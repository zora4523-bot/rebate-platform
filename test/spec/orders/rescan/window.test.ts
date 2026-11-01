// B1-04zm: pure rescan window arithmetic (规划/02 §7.1; D10-543).
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  RESCAN_START_MARGIN_MS,
  rescanIntervalSeconds,
  rescanStep,
} from '../../../../apps/api/src/modules/orders/domain/sync-window.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, NOW_MS } from './kit.ts';

const ROUND_START = NOW_MS - 30 * DAY_MS + RESCAN_START_MARGIN_MS;

/** The range one round covers: it starts the margin after now − days. */
const rangeMs = (days: number): number => days * DAY_MS - RESCAN_START_MARGIN_MS;

interface Round {
  readonly windows: readonly { readonly startMs: number; readonly endMs: number }[];
  readonly restartMs: number;
}

/** One whole round with the clock held at `nowMs`; null when it never ends. */
function walk(nowMs: number, days: number, capMs: number, ceilingMs?: number): Round | null {
  const limit = Math.floor((days * DAY_MS) / capMs) + 1;
  const windows: { startMs: number; endMs: number }[] = [];
  let cursor: number | null = null;
  // rescanStep comes before the limit: the margin is undefined on the skeleton, so capMs and limit
  // are NaN, and the property must still end in NotImplemented rather than return false.
  for (let step = 0; ; step += 1) {
    const next = rescanStep(cursor, nowMs, days, capMs, ceilingMs);
    if (next.kind === 'round_end') return { windows, restartMs: next.restartMs };
    if (step > limit) return null;
    windows.push({ startMs: next.startMs, endMs: next.endMs });
    cursor = next.endMs;
  }
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

/** A round with an earlier end: the same windows from the same start, none past the ceiling. */
function stopsAtCeiling(nowMs: number, days: number, capMs: number, ceilingMs: number): boolean {
  const round = walk(nowMs, days, capMs, ceilingMs);
  if (round === null) return false;
  const fromMs = nowMs - rangeMs(days);
  const tailMs = round.windows.at(-1)?.endMs ?? fromMs;
  return (
    round.restartMs === fromMs &&
    round.windows.every(
      (win, index) =>
        win.endMs - win.startMs === capMs &&
        win.startMs === (round.windows[index - 1]?.endMs ?? fromMs) &&
        win.endMs <= ceilingMs,
    ) &&
    ceilingMs - tailMs < capMs
  );
}

// A round of at most about 32 windows keeps the default 10000 runs well inside the test timeout;
// the jd case of 719 windows has its own test below.
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
  { label: '游标为空', cursorMs: null, startMs: ROUND_START },
  { label: '游标早于一轮起点', cursorMs: ROUND_START - 1, startMs: ROUND_START },
  { label: '游标等于一轮起点', cursorMs: ROUND_START, startMs: ROUND_START },
  { label: '游标在范围内', cursorMs: ROUND_START + 5, startMs: ROUND_START + 5 },
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
])('[AC-B1-04zm#4] $label：本轮结束，回到 now − days + 1 小时', ({ cursorMs }) => {
  expect(rescanStep(cursorMs, NOW_MS, 30, HOUR_MS)).toEqual({
    kind: 'round_end',
    restartMs: ROUND_START,
  });
});

it('[AC-B1-04zm#5] 京东 30 天 60 分钟窗一轮正好 719 窗，首尾相接到 now', () => {
  const round = walk(NOW_MS, 30, HOUR_MS);
  expect(round?.windows).toHaveLength(719);
  expect(round?.windows.at(-1)?.endMs).toBe(NOW_MS);
  expect(round === null ? false : joined(round, ROUND_START, HOUR_MS)).toBe(true);
});

it('[AC-B1-04zm#6] 任意 days 与 cap：窗口不重不漏，尾段不足一窗时由下一轮补上，两轮覆盖 [now − days + 1 小时, now]', () => {
  expect(() =>
    fc.assert(
      fc.property(cases, ({ nowMs, days, capMs }) => coversRange(nowMs, days, capMs)),
      propParams(),
    ),
  ).not.toThrow();
});

const CEILING = NOW_MS - 3 * HOUR_MS;

it('[AC-B1-04zm#71] 终点早于 now：最后一窗正好到终点', () => {
  expect(rescanStep(CEILING - HOUR_MS, NOW_MS, 30, HOUR_MS, CEILING)).toEqual({
    kind: 'window',
    startMs: CEILING - HOUR_MS,
    endMs: CEILING,
  });
});

it.each([
  { label: '差 1 毫秒不足一窗', cursorMs: CEILING - HOUR_MS + 1 },
  { label: '游标等于终点', cursorMs: CEILING },
  { label: '游标晚于终点', cursorMs: CEILING + 1 },
])('[AC-B1-04zm#72] $label：离 now 还够一窗也结束本轮，起点仍按 now 算', ({ cursorMs }) => {
  expect(rescanStep(cursorMs, NOW_MS, 30, HOUR_MS, CEILING)).toEqual({
    kind: 'round_end',
    restartMs: ROUND_START,
  });
});

it('[AC-B1-04zm#73] 任意终点：窗口首尾相接、不越过终点，尾段不足一窗，起点不随终点变', () => {
  const ceilings = fc.record({ round: cases, back: fc.integer({ min: 0, max: 1200 }) });
  expect(() =>
    fc.assert(
      fc.property(ceilings, ({ round: { nowMs, days, capMs }, back }) =>
        // back above 1000 puts the ceiling before the round's start: no window fits.
        stopsAtCeiling(nowMs, days, capMs, nowMs - Math.floor((rangeMs(days) * back) / 1000)),
      ),
      propParams(),
    ),
  ).not.toThrow();
});
