import { expect, it } from 'vitest';
import { ENTRIES, EVENTS, LEGAL, STATES, transitionFunction } from './kit.ts';

it.each(ENTRIES)('[AC-F1-09h#4] $name 接受三行合法迁移并返回固定行号', ({ load }) => {
  const transition = transitionFunction(load());
  for (const row of LEGAL) {
    expect(transition(row.from, row.event)).toEqual({
      ok: true,
      to: row.to,
      id: row.id,
      noop: false,
    });
  }
});

// 四个起点 × 三个事件，排除三行合法组合，穷举剩余九个。
// 包含 draft 直接回滚、published 回 draft/重复发布、rolled_back 全部事件及各自迁移。
const ILLEGAL = [null, ...STATES].flatMap((from) =>
  EVENTS.filter((event) => !LEGAL.some((row) => row.from === from && row.event === event)).map(
    (event) => ({ from, event }),
  ),
);

it.each(ILLEGAL)('[AC-F1-09h#5] $from + $event 是表外组合，不得迁移或 noop', ({ from, event }) => {
  for (const entry of ENTRIES) {
    expect(transitionFunction(entry.load())(from, event)).toEqual({
      ok: false,
      reason: 'illegal',
      id: null,
    });
  }
});

it.each(ENTRIES)('[AC-F1-09h#6] $name 拒绝未知状态、大小写变体及原型属性名', ({ load }) => {
  const transition = transitionFunction(load());
  for (const from of ['unknown', '', 'DRAFT', 'revoked', 'same', '__proto__', 'constructor']) {
    for (const event of EVENTS) {
      expect(transition(from, event)).toEqual({ ok: false, reason: 'illegal', id: null });
    }
  }
});

it.each(ENTRIES)('[AC-F1-09h#7] $name 拒绝未知事件；调灰度和转全量不新增状态迁移', ({ load }) => {
  const transition = transitionFunction(load());
  for (const event of [
    'UNKNOWN',
    '',
    'publish',
    'DRAFT_CREATED',
    'SET_GRAY_PERCENT',
    'PROMOTE_TO_FULL',
    '__proto__',
    'constructor',
  ]) {
    for (const from of [null, ...STATES]) {
      expect(transition(from, event)).toEqual({ ok: false, reason: 'illegal', id: null });
    }
  }
});
