// B3-03g: the two forms of a terminal frame and the run timing check (design §3.4, §5.1;
// final_event / end_draft shape of 0021 / 0023). Pure: no database.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';

import {
  StoredFrameInvalid,
  assertRunTimings,
  fromStored,
  runTimingsDefaults,
  toStored,
  withQuota,
} from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import type {
  TerminalDraft,
  TerminalFrame,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';

const FINISH = [
  'stop',
  'cancelled',
  'limit',
  'budget',
  'error',
  'auth_required',
  'safety',
  'fallback',
  'timeout',
] as const;

const errorData = fc.record(
  {
    code: fc.integer({ min: 10_000, max: 59_999 }),
    msg: fc.string({ minLength: 1, maxLength: 20 }),
    retryable: fc.boolean(),
    fallback: fc.option(fc.string({ maxLength: 10 }), { nil: null }),
    fallback_q: fc.option(fc.string({ maxLength: 10 }), { nil: null }),
  },
  { requiredKeys: ['code', 'msg', 'retryable', 'fallback'] },
);
const draftArb: fc.Arbitrary<TerminalDraft> = fc.oneof(
  fc.constantFrom(...FINISH).map((f) => ({ event: 'done' as const, data: { finish_reason: f } })),
  errorData.map((data) => ({ event: 'error' as const, data })),
);

it('[AC-B3-03g#40] toStored / fromStored 往返：持久化形状恰为 {type, data}，终态帧与草稿各自还原；withQuota 只给 done 加 quota_left', () => {
  expect(withQuota({ event: 'done', data: { finish_reason: 'stop' } }, 0)).toEqual({
    event: 'done',
    data: { finish_reason: 'stop', quota_left: 0 },
  });
  const holds = (draft: TerminalDraft, quota: number): boolean => {
    const frame = withQuota(draft, quota);
    const storedDraft = toStored(draft);
    const storedFrame = toStored(frame);
    expect(Object.keys(storedFrame).sort()).toEqual(['data', 'type']);
    expect(storedFrame.type).toBe(draft.event);
    expect(fromStored(JSON.parse(JSON.stringify(storedDraft)) as unknown, 'draft')).toEqual(draft);
    expect(fromStored(JSON.parse(JSON.stringify(storedFrame)) as unknown, 'final')).toEqual(frame);
    if (draft.event === 'done') {
      expect(frame).toEqual({ event: 'done', data: { ...draft.data, quota_left: quota } });
    } else {
      expect(frame).toEqual(draft);
    }
    return true;
  };
  const details = fc.check(fc.property(draftArb, fc.nat({ max: 1_000 }), holds), propParams());
  expect(details.failed, fc.defaultReportMessage(details) ?? '').toBe(false);
});

it('[AC-B3-03g#41] fromStored 拒绝不合格的持久化值（StoredFrameInvalid）：多余键、未知 type、非对象 data、坏 finish_reason、终态缺 quota_left、草稿带 quota_left、负数剩余', () => {
  const done: TerminalFrame = { event: 'done', data: { finish_reason: 'stop', quota_left: 3 } };
  expect(
    fromStored({ type: 'done', data: { finish_reason: 'stop', quota_left: 3 } }, 'final'),
  ).toEqual(done);
  const bad: [unknown, 'final' | 'draft'][] = [
    [null, 'final'],
    [[], 'final'],
    ['done', 'final'],
    [{ type: 'done', data: { finish_reason: 'stop', quota_left: 3 }, extra: 1 }, 'final'],
    [{ type: 'ping', data: {} }, 'final'],
    [{ type: 'done', data: [] }, 'final'],
    [{ type: 'done', data: { finish_reason: 42, quota_left: 1 } }, 'final'],
    [{ type: 'done', data: { finish_reason: 'stop' } }, 'final'],
    [{ type: 'done', data: { finish_reason: 'stop', quota_left: -1 } }, 'final'],
    [{ type: 'done', data: { finish_reason: 'stop', quota_left: 1.5 } }, 'final'],
    [{ type: 'done', data: { finish_reason: 'stop', quota_left: 1 } }, 'draft'],
    [{ type: 'error', data: { code: 'x' } }, 'draft'],
    [{ event: 'done', data: { finish_reason: 'stop' } }, 'draft'],
  ];
  for (const [value, kind] of bad) {
    expect(() => fromStored(value, kind), JSON.stringify(value)).toThrow(StoredFrameInvalid);
  }
});

it('[AC-B3-03g#42] 运行时长配置：默认 20 000 / 30 000 / 2 000；runMaxMs 须等于受理的 runMaxMs，宽限 ≥ 30 s，0 < PG 取消轮询 ≤ 5 s，余量 ≥ 0', () => {
  expect(runTimingsDefaults()).toEqual({
    runMaxMs: 20_000,
    lockGraceMs: 30_000,
    cancelPgPollMs: 2_000,
  });
  const ok = {
    runMaxMs: 20_000,
    lockGraceMs: 30_000,
    cancelPgPollMs: 2_000,
    admissionRunMaxMs: 20_000,
    sweepMarginMs: 10_000,
  };
  expect(() => assertRunTimings(ok)).not.toThrow();
  expect(() => assertRunTimings({ ...ok, cancelPgPollMs: 5_000, sweepMarginMs: 0 })).not.toThrow();
  for (const wrong of [
    { admissionRunMaxMs: 20_001 },
    { lockGraceMs: 29_999 },
    { cancelPgPollMs: 0 },
    { cancelPgPollMs: 5_001 },
    { sweepMarginMs: -1 },
    { runMaxMs: 20_000.5, admissionRunMaxMs: 20_000.5 },
  ]) {
    expect(() => assertRunTimings({ ...ok, ...wrong }), JSON.stringify(wrong)).toThrow(RangeError);
  }
});
