import { expect, it } from 'vitest';
import {
  MAX_SCHEDULE_AHEAD_MS,
  effectivePage,
  effectiveVersion,
  isSchedulable,
  slotDelaySeconds,
  slotOf,
} from './schedule.ts';

const NOW = new Date('2026-10-22T00:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);

it('[AC-F1-09p#d1] schedulable window is (now, now + 30 days]', () => {
  expect(isSchedulable(NOW, NOW)).toBe(false);
  expect(isSchedulable(at(-1), NOW)).toBe(false);
  expect(isSchedulable(at(1), NOW)).toBe(true);
  expect(isSchedulable(at(MAX_SCHEDULE_AHEAD_MS), NOW)).toBe(true);
  expect(isSchedulable(at(MAX_SCHEDULE_AHEAD_MS + 1), NOW)).toBe(false);
  expect(isSchedulable(new Date(Number.NaN), NOW)).toBe(false);
});

it('[AC-F1-09p#d2] delay rounds the remaining time up, at least one second', () => {
  expect(slotDelaySeconds(at(10_001), NOW)).toBe(11);
  expect(slotDelaySeconds(at(1), NOW)).toBe(1);
  expect(slotDelaySeconds(at(-5_000), NOW)).toBe(1);
  expect(slotDelaySeconds(at(MAX_SCHEDULE_AHEAD_MS), NOW)).toBe(2_592_000);
});

it('[AC-F1-09p#d3] effectivePage applies a slot from its instant on, without mutating the row', () => {
  const row = {
    currentVersion: 1,
    grayVersion: null,
    grayPercent: 0,
    revision: 4,
    updatedBy: 'ops',
    updatedAt: NOW,
    slot: { version: 2, grayPercent: 10, at: at(1000), by: 'planner' },
  };
  const copy = structuredClone(row);
  expect(effectivePage(row, at(999))).toEqual({ ...row, applied: null });
  expect(effectivePage(row, at(1000))).toEqual({
    currentVersion: 1,
    grayVersion: 2,
    grayPercent: 10,
    revision: 5,
    updatedBy: 'planner',
    updatedAt: at(1000),
    slot: null,
    applied: row.slot,
  });
  expect(
    effectivePage({ ...row, slot: { ...row.slot, grayPercent: 100 } }, at(2000)),
  ).toMatchObject({ currentVersion: 2, grayVersion: null, grayPercent: 0 });
  expect(row).toEqual(copy);
});

it('[AC-F1-09p#d4] effectiveVersion reports only the due slot draft as published', () => {
  const slot = { version: 2, grayPercent: 100, at: at(1000), by: 'planner' };
  const draft = {
    version: 2,
    status: 'draft',
    publishAt: null as Date | null,
    publisher: null as string | null,
  };
  expect(effectiveVersion(draft, slot, at(999))).toBe(draft);
  expect(effectiveVersion(draft, slot, at(1000))).toEqual({
    version: 2,
    status: 'published',
    publishAt: at(1000),
    publisher: 'planner',
  });
  const other = { ...draft, version: 3 };
  expect(effectiveVersion(other, slot, at(5000))).toBe(other);
  const rolled = { ...draft, status: 'rolled_back' };
  expect(effectiveVersion(rolled, slot, at(5000))).toBe(rolled);
  expect(effectiveVersion(draft, null, at(5000))).toBe(draft);
});

it('[AC-F1-09p#d5] slotOf needs all four columns', () => {
  expect(slotOf({ version: 2, grayPercent: 100, at: NOW, by: 'a' })).toEqual({
    version: 2,
    grayPercent: 100,
    at: NOW,
    by: 'a',
  });
  expect(slotOf({ version: 2, grayPercent: 100, at: NOW, by: null })).toBeNull();
  expect(slotOf({ version: undefined, grayPercent: 100, at: NOW, by: 'a' })).toBeNull();
});
