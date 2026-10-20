import { expect, it } from 'vitest';
import { ENTRIES, ILLEGAL, LEGAL, transitionFunction } from './kit.ts';

const legalCases = ENTRIES.flatMap((entry) => LEGAL.map((row) => ({ entry, ...row })));
const illegalCases = ENTRIES.flatMap((entry) => ILLEGAL.map((row) => ({ entry, ...row })));

it.each(legalCases)(
  '[AC-B1-15b#4] [SM-DEL-$id] $entry.name：$from + $event → $to，非 noop',
  ({ entry, id, from, event, to }) => {
    expect(transitionFunction(entry.load())(from, event)).toEqual({
      ok: true,
      to,
      id,
      noop: false,
    });
  },
);

// 5 起点 × 3 事件 − 3 合法 = 12 表外组合。
// 包含 null 全事件、全部终态、processing+CANCEL 及 cooling+COMPLETE。
it.each(illegalCases)(
  '[AC-B1-15b#5] $entry.name：$from + $event 是表外组合',
  ({ entry, from, event }) => {
    expect(ILLEGAL).toHaveLength(12);
    expect(transitionFunction(entry.load())(from, event)).toEqual({
      ok: false,
      reason: 'illegal',
      id: null,
    });
  },
);
