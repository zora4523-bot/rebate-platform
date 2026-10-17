import { expect, it } from 'vitest';
import * as domain from '@couli/domain';
import {
  generatedText,
  machine,
  PLATFORM_EVENTS,
  PLATFORM_IDS,
  PLATFORM_STATES,
  REBATE_IDS,
  REBATE_STATES,
  rowsFor,
  yamlText,
} from './kit.ts';
import { REBATE_RULES } from './rebate-cases.ts';

const MACHINES = [
  {
    name: 'order-platform',
    field: 'platform_status',
    prefix: 'SM-PLT-',
    ids: PLATFORM_IDS,
    states: PLATFORM_STATES,
    constant: 'ORDER_PLATFORM',
  },
  {
    name: 'order-rebate',
    field: 'rebate_status',
    prefix: 'SM-REB-',
    ids: REBATE_IDS,
    states: REBATE_STATES,
    constant: 'ORDER_REBATE',
  },
] as const;

it.each(MACHINES)('[AC-CT-04a-SOURCE#1] $name 覆盖全部编号、状态与 test_id', (expected) => {
  const doc = machine(expected.name);
  expect(doc.name).toBe(expected.name);
  expect(doc.field).toBe(expected.field);
  expect([...doc.states].sort()).toEqual([...expected.states].sort());
  expect([...new Set(doc.transitions.map((r) => r.id))].sort()).toEqual([...expected.ids].sort());
  expect(doc.events.length).toBeGreaterThan(0);
  expect(new Set(doc.events).size).toBe(doc.events.length);
  for (const event of doc.events) expect(event).toMatch(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/);
  for (const row of doc.transitions) {
    expect(row.test_id).toBe(`${expected.prefix}${row.id}`);
    expect(row.guard).toEqual(expect.any(String));
    expect(row.from.length).toBeGreaterThan(0);
    expect(new Set(row.from).size).toBe(row.from.length);
    for (const from of row.from) expect([null, '*', ...doc.states]).toContain(from);
    expect(['same', ...doc.states]).toContain(row.to);
    if (row.kind !== 'backward' && row.kind !== 'same_state') {
      expect(doc.events).toContain(row.event);
      expect(row.from).not.toContain('*');
      expect(row.kind === undefined || row.kind === 'transition').toBe(true);
    }
  }
  const used = doc.transitions
    .filter((r) => r.kind !== 'backward' && r.kind !== 'same_state')
    .map((r) => r.event);
  expect([...new Set(used)].sort()).toEqual([...doc.events].sort());
});

const PLATFORM_RULES = [
  { id: 'P1', from: [null], events: ['PLATFORM_DEPOSIT_PAID'], to: 'DEPOSIT_PAID' },
  { id: 'P2', from: [null, 'DEPOSIT_PAID'], events: ['PLATFORM_PAID'], to: 'PAID' },
  { id: 'P3', from: ['PAID'], events: ['PLATFORM_RECEIVED'], to: 'RECEIVED' },
  { id: 'P4', from: ['RECEIVED'], events: ['PLATFORM_SETTLED'], to: 'SETTLED' },
  { id: 'P5', from: ['DEPOSIT_PAID', 'PAID'], events: ['PLATFORM_SETTLED'], to: 'SETTLED' },
  {
    id: 'P6',
    from: ['DEPOSIT_PAID', 'PAID', 'RECEIVED'],
    events: ['PLATFORM_INVALID'],
    to: 'INVALID',
  },
  { id: 'P7', from: ['SETTLED'], events: ['PLATFORM_INVALID'], to: 'same' },
  {
    id: 'P8',
    from: ['PAID', 'RECEIVED', 'SETTLED'],
    events: ['PLATFORM_RIGHTS', 'PLATFORM_PUNISH'],
    to: 'same',
  },
  { id: 'P9', from: ['INVALID'], events: ['PLATFORM_PAID'], to: 'PAID' },
  { id: 'P9', from: ['INVALID'], events: ['PLATFORM_RECEIVED'], to: 'RECEIVED' },
  { id: 'P9', from: ['INVALID'], events: ['PLATFORM_SETTLED'], to: 'SETTLED' },
  { id: 'P11', from: [null], events: ['PLATFORM_RECEIVED'], to: 'RECEIVED' },
  { id: 'P12', from: [null], events: ['PLATFORM_SETTLED'], to: 'SETTLED' },
  { id: 'P13', from: [null], events: ['PLATFORM_INVALID'], to: 'INVALID' },
  { id: 'P14', from: ['DEPOSIT_PAID'], events: ['PLATFORM_RECEIVED'], to: 'RECEIVED' },
];

it('[AC-CT-04a-SOURCE#2] 平台 YAML 的全部普通迁移与 BR-FUND-01 逐项一致', () => {
  const doc = machine('order-platform');
  expect([...doc.events].sort()).toEqual([...PLATFORM_EVENTS].sort());
  const actual = doc.transitions
    .filter((r) => !['P10', 'P15'].includes(r.id))
    .flatMap((r) => r.from.map((from) => JSON.stringify([r.id, from, r.event, r.to])));
  const expected = PLATFORM_RULES.flatMap((r) =>
    r.from.flatMap((from) => r.events.map((event) => JSON.stringify([r.id, from, event, r.to]))),
  );
  expect(actual.sort()).toEqual(expected.sort());
});

it.each([
  { id: 'P10', kind: 'backward' },
  { id: 'P15', kind: 'same_state' },
])('[AC-CT-04a-SOURCE#3] [SM-PLT-$id] 特殊判定不成为独立事件', ({ id, kind }) => {
  const doc = machine('order-platform');
  const rows = rowsFor(doc, id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ from: ['*'], to: 'same', kind });
  expect(doc.events).not.toContain(rows[0]?.event);
});

it.each(REBATE_RULES)(
  '[AC-CT-04a-SOURCE#4] [SM-REB-$id] 返利 YAML 保留起点、目标、守卫与编码',
  (rule) => {
    const doc = machine('order-rebate');
    const rows = rowsFor(doc, rule.id);
    const events = [...new Set(rows.map((row) => row.event))];
    if (rule.events) expect(events.sort()).toEqual([...rule.events].sort());
    for (const event of events) {
      const from = rows.filter((r) => r.event === event).flatMap((r) => r.from);
      expect([...from].sort()).toEqual([...rule.from].sort());
    }
    for (const row of rows) {
      expect(rule.targets).toContain(row.to);
      for (const term of rule.guardTerms ?? []) expect(row.guard).toContain(term);
    }
    // 中文事件的编码由实现者选，必须在 YAML 注释保留对应原文。
    const comments = yamlText('order-rebate')
      .split('\n')
      .filter((line) => line.includes('#'))
      .join('\n');
    for (const word of rule.words ?? []) expect(comments).toContain(word);
  },
);

it('[AC-CT-04a-SOURCE#6] [SM-REB-R8] 黑名单人工确认使用原文事件编码', () => {
  const doc = machine('order-rebate');
  expect(rowsFor(doc, 'R8').map((row) => row.event)).toContain('BLACKLIST_CONFIRMED');
});

it.each(MACHINES)('[AC-CT-04a-SOURCE#5] $name 公开常量、只读迁移表与 YAML 一致', (expected) => {
  const doc = machine(expected.name);
  const exports: Record<string, unknown> = domain;
  expect(exports[`${expected.constant}_STATES`]).toEqual(doc.states);
  expect(exports[`${expected.constant}_EVENTS`]).toEqual(doc.events);
  expect(exports[`${expected.constant}_TRANSITIONS`]).toEqual(doc.transitions);
  expect(generatedText(expected.name)).toContain('生成物，勿手改');
  expect(generatedText(expected.name)).toContain(`specs/state-machines/${expected.name}.yaml`);
});
