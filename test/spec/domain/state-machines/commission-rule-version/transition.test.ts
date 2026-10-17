import { expect, it } from 'vitest';
import { generatedExports, readRequired } from '../../../state-machines/order/kit.ts';
import {
  EVENTS,
  LEGAL,
  machine,
  publicExports,
  STATES,
  TARGET,
  transitionFunction,
} from './kit.ts';

// 同时覆盖入库生成物与包入口，防止入口另导出一套手写实现。
const ENTRIES = [
  { name: '包入口', load: publicExports },
  { name: '生成物', load: () => generatedExports(readRequired(TARGET)) },
];

it.each(ENTRIES)('[AC-B2-03j#5] $name 逐项接受三行合法迁移且返回对应行号', ({ load }) => {
  const transition = transitionFunction(load());
  const doc = machine();
  for (const expected of LEGAL) {
    const row = doc.transitions.find((candidate) => candidate.event === expected.event);
    expect(row).toBeDefined();
    expect(transition(expected.from, expected.event)).toEqual({
      ok: true,
      to: expected.to,
      id: row?.id,
      noop: false,
    });
  }
});

// 4 个起点 × 3 个事件，排除 3 行合法迁移，穷举其余 9 个组合。
// 包括重复入库、自迁移、draft 撤销、published 回退及 revoked 的全部事件。
const ILLEGAL = [null, ...STATES].flatMap((from) =>
  EVENTS.filter((event) => !LEGAL.some((row) => row.from === from && row.event === event)).map(
    (event) => ({ from, event }),
  ),
);

it.each(ILLEGAL)('[AC-B2-03j#6] 非法组合 $from + $event 拒绝迁移', ({ from, event }) => {
  for (const entry of ENTRIES) {
    const transition = transitionFunction(entry.load());
    // 沿用 CT-04a 的返回契约：领域表返回 illegal，由调用方转换为业务异常。
    expect(transition(from, event)).toEqual({ ok: false, reason: 'illegal', id: null });
  }
});
