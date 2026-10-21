import { expect, it } from 'vitest';
import { EDGES, ENTRIES, EVENTS, machine, STATES, transitionFunction } from './kit.ts';

const LEGAL_CASES = ENTRIES.flatMap((entry) => EDGES.map((edge) => ({ entry, ...edge })));

it.each(LEGAL_CASES)(
  '[AC-B1-34g#2] $entry.name：$from + $event → $to，返回迁移编号且非 noop',
  ({ entry, from, event, to }) => {
    const result = transitionFunction(entry.load())(from, event);
    expect(result).toEqual({ ok: true, to, id: expect.stringMatching(/\S/), noop: false });
    const rows = machine().transitions.filter(
      (row) => row.from.includes(from) && row.event === event,
    );
    expect(rows).toHaveLength(1);
    expect(result).toMatchObject({ id: rows[0]!.id });
  },
);

// 7 个起点（含 null）× 6 个事件，排除 7 条合法边，剩余 35 个组合。
// 其中 12 个终态组合单列，以免遗漏过期后重试或取消后重启。
const ILLEGAL_CASES = [null, ...STATES].flatMap((from) =>
  EVENTS.filter((event) => !EDGES.some((edge) => edge.from === from && edge.event === event)).map(
    (event) => ({ from, event }),
  ),
);
const NONTERMINAL_CASES = ENTRIES.flatMap((entry) =>
  ILLEGAL_CASES.filter(({ from }) => from !== 'expired' && from !== 'cancelled').map((pair) => ({
    entry,
    ...pair,
  })),
);
const TERMINAL_CASES = ENTRIES.flatMap((entry) =>
  ILLEGAL_CASES.filter(({ from }) => from === 'expired' || from === 'cancelled').map((pair) => ({
    entry,
    ...pair,
  })),
);

// 与共用生成器一致，非法迁移返回 illegal 结果；直接调用确保 NotImplemented 仍为红。
it.each(NONTERMINAL_CASES)(
  '[AC-B1-34g#3] $entry.name：表外组合 $from + $event 返回 illegal',
  ({ entry, from, event }) => {
    const transition = transitionFunction(entry.load());
    expect(transition(from, event)).toEqual({ ok: false, reason: 'illegal', id: null });
  },
);

it.each(TERMINAL_CASES)(
  '[AC-B1-34g#4] $entry.name：终态 $from + $event 返回 illegal',
  ({ entry, from, event }) => {
    const transition = transitionFunction(entry.load());
    expect(transition(from, event)).toEqual({ ok: false, reason: 'illegal', id: null });
  },
);
