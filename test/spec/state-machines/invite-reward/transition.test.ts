import { expect, it } from 'vitest';
import { ENTRIES, ILLEGAL, LEGAL, transitionOf } from './kit.ts';

const LEGAL_CASES = ENTRIES.flatMap((entry) => LEGAL.map((row) => ({ entry, ...row })));
const ILLEGAL_CASES = ENTRIES.flatMap((entry) => ILLEGAL.map((row) => ({ entry, ...row })));

it.each(LEGAL_CASES)(
  '[AC-B1-35a#4] [SM-IRW-$id] $entry.name：$from + $event → $to（noop=$noop）',
  ({ entry, from, event, to, id, noop }) => {
    expect(transitionOf(entry.load())(from, event)).toEqual({ ok: true, to, id, noop });
  },
);

// 6 个起点（含 null）× 3 个事件，减去 6 个合法组合 = 12 个表外组合；
// null 表示不存在资格行，三个终态均不能重新触发或发放。
it.each(ILLEGAL_CASES)(
  '[AC-B1-35a#5] $entry.name：$from + $event 为表外组合',
  ({ entry, from, event }) => {
    expect(transitionOf(entry.load())(from, event)).toEqual({
      ok: false,
      reason: 'illegal',
      id: null,
    });
  },
);
