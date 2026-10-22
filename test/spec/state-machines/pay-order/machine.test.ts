import { expect, it } from 'vitest';
import { renderStateMachine } from '../../../../packages/domain/scripts/state-machines.ts';
import {
  ENTRIES,
  expectedRows,
  exportsOf,
  generatedPath,
  machine,
  matrix,
  readRequired,
  sourcePath,
  transitionOf,
  verifyCli,
} from './kit.ts';

// BR-PAY-02/04/05 独立盲录；不得根据待测实现生成状态、事件或期望迁移。
const NAME = 'pay-order';
const STATES = ['PENDING', 'PAID', 'CLOSED'];
const EVENTS = ['CREATE', 'PAY_SUCCESS', 'CLOSE'];
const IDS = ['PO1', 'PO2', 'PO3'];
const ROWS = expectedRows(NAME);

it('[AC-CT-21d#1] YAML 只有三态、三个事件和三条迁移，初态来自 null', () => {
  const doc = machine(NAME);
  expect(doc.name).toBe(NAME);
  expect(doc.field).toBe('status');
  expect(doc.states).toEqual(STATES);
  expect([...doc.events].sort()).toEqual([...EVENTS].sort());
  expect(doc.transitions.map((row) => row.id).sort()).toEqual(IDS);
  expect(ROWS.map((row) => row.id)).toEqual(IDS);
  for (const row of doc.transitions) {
    expect(row.to).not.toBe('same');
    expect(row.from).not.toContain(row.to);
  }
});

it.each(IDS)('[AC-CT-21d#2] [SM-PAY-%s] 起点、事件、目标及守卫要点符合独立 CSV', (id) => {
  const expected = ROWS.find((row) => row.id === id);
  expect(expected).toBeDefined();
  const rows = machine(NAME).transitions.filter((row) => row.id === id);
  expect(rows).toHaveLength(1);
  for (const row of rows) {
    expect(row.from).toEqual([expected!.from]);
    expect(row.event).toBe(expected!.event);
    expect(row.to).toBe(expected!.to);
    expect(row.test_id).toBe(expected!.testId);
    expect(row.kind === undefined || row.kind === 'transition').toBe(true);
    expect(row).not.toHaveProperty('alternatives');
    for (const point of expected!.guardPoints) expect(row.guard).toContain(point);
  }
});

it.each(ENTRIES)('[AC-CT-21d#3] %s 导出完整状态、事件、迁移表且与 YAML 一致', (entry) => {
  const exported = exportsOf(NAME, entry);
  expect(exported['PAY_ORDER_STATES']).toEqual(STATES);
  expect(exported['PAY_ORDER_EVENTS']).toEqual(EVENTS);
  const doc = machine(NAME);
  expect(exported['PAY_ORDER_TRANSITIONS']).toEqual(doc.transitions);
  expect(doc.transitions.map((row) => row.id).sort()).toEqual(IDS);
});

it.each(matrix(STATES, EVENTS))(
  '[AC-CT-21d#4] $entry：$from + $event 全矩阵，终态不可退出或重复迁移',
  ({ entry, from, event }) => {
    const rule = ROWS.find((row) => row.from === from && row.event === event);
    const expected =
      rule === undefined
        ? { ok: false, reason: 'illegal', id: null }
        : { ok: true, to: rule.to, id: rule.id, noop: false };
    expect(transitionOf(NAME, entry)(from, event)).toEqual(expected);
  },
);

// 非清单结果、客户端结果、其他状态机事件都不能被解释成支付/退款成功。
// 从 null 与每个合法状态调用，避免只对终态作特判。
it.each(matrix(STATES, ['UNKNOWN', 'CLIENT_SUCCESS', 'SUCCESS', 'FAILED', 'REFUND', 'CANCEL', '']))(
  '[AC-CT-21d#5] $entry：$from 拒绝未知事件 $event',
  ({ entry, from, event }) => {
    expect(transitionOf(NAME, entry)(from, event)).toEqual({
      ok: false,
      reason: 'illegal',
      id: null,
    });
  },
);

it('[AC-CT-21d#6] YAML 与生成物逐字一致，守卫只是说明、无上下文也可判定合法迁移', () => {
  const yaml = readRequired(sourcePath(NAME));
  expect(readRequired(generatedPath(NAME))).toBe(renderStateMachine(yaml));
  // 不向纯状态机传验签、金额、时钟或数据库上下文；这些由调用方负责。
  for (const row of ROWS) {
    expect(transitionOf(NAME, 'generated')(row.from, row.event)).toEqual({
      ok: true,
      to: row.to,
      id: row.id,
      noop: false,
    });
  }
});

it('[AC-CT-21d#7] --verify 接受一致文件，拒绝过期生成物且不改文件', async () => {
  await verifyCli(NAME);
});
