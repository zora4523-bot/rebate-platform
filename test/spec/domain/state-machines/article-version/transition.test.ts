import { expect, it } from 'vitest';
import { ENTRIES, EVENTS, LEGAL, STATES, transitionFunction } from './kit.ts';

it.each(ENTRIES)('[AC-F1-02u#4] $name 接受三行合法迁移并返回对应行号', ({ load }) => {
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

// 四个起点 × 三个事件减去三行合法迁移，穷举全部九个表外组合。
// 包含 offline 终态的所有事件、重复发布、published 回草稿和 draft 直接下线。
const ILLEGAL = [null, ...STATES].flatMap((from) =>
  EVENTS.filter((event) => !LEGAL.some((row) => row.from === from && row.event === event)).map(
    (event) => ({ from, event }),
  ),
);

it.each(ILLEGAL)('[AC-F1-02u#5] $from + $event 不得迁移或作为 noop 成功', ({ from, event }) => {
  for (const entry of ENTRIES) {
    expect(transitionFunction(entry.load())(from, event)).toEqual({
      ok: false,
      reason: 'illegal',
      id: null,
    });
  }
});

it.each(ENTRIES)('[AC-F1-02u#6] $name 拒绝未知状态和大小写、空白变体', ({ load }) => {
  const transition = transitionFunction(load());
  for (const from of [
    'unknown',
    '',
    'DRAFT',
    'Published',
    'OFFLINE',
    'rolled_back',
    'same',
    ' published',
    'published\u200b',
    '__proto__',
    'constructor',
  ]) {
    for (const event of EVENTS) {
      expect(transition(from, event)).toEqual({ ok: false, reason: 'illegal', id: null });
    }
  }
});

it.each(ENTRIES)('[AC-F1-02u#7] $name 拒绝未知事件，不接受正文修改或重新上线事件', ({ load }) => {
  const transition = transitionFunction(load());
  for (const event of [
    'UNKNOWN',
    '',
    'publish',
    'offline',
    'draft_saved',
    'EDIT',
    'REPUBLISH',
    'ROLLBACK',
    'PUBLISH ',
    'PUBLISH\u200b',
    '__proto__',
    'constructor',
  ]) {
    for (const from of [null, ...STATES]) {
      expect(transition(from, event)).toEqual({ ok: false, reason: 'illegal', id: null });
    }
  }
});
