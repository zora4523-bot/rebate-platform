import { expect, it } from 'vitest';
import { readRequired } from '../../../state-machines/order/kit.ts';
import {
  assertDefinition,
  assertGenerated,
  ENTRIES,
  ILLEGAL,
  illegalPairs,
  machine,
  transition,
  type Contract,
} from './kit.ts';

// 独立预期：SPEC_REF 的 BR-FUND-04 细则；按任务第 10 节，SB10 仅留注释、按表外事件拒绝。
// 合法迁移仅 SB1–SB9；事件英文名是本任务的技术命名。
// SB9 明确到 EXECUTING（有续跑动作），不是忽略同状态报文的 noop。
const BATCH = {
  name: 'settle-batch',
  prefix: 'SETTLE_BATCH',
  functionName: 'transitionSettleBatch',
  enumName: 'settle_batch_status',
  states: ['DRAFT', 'CONFIRMED', 'EXECUTING', 'PARTIAL', 'DONE', 'CANCELLED'],
  events: [
    'GENERATE',
    'CONFIRM',
    'CANCEL_SCHEDULE',
    'REJECT',
    'START',
    'COMPLETE',
    'SWITCH_OFF',
    'RESUME',
    'TAKE_OVER',
    'MANUAL_START',
  ],
  rows: [
    { id: 'SB1', from: null, event: 'GENERATE', to: 'DRAFT' },
    { id: 'SB2', from: 'DRAFT', event: 'CONFIRM', to: 'CONFIRMED' },
    { id: 'SB3', from: 'CONFIRMED', event: 'CANCEL_SCHEDULE', to: 'DRAFT' },
    { id: 'SB4', from: 'DRAFT', event: 'REJECT', to: 'CANCELLED' },
    { id: 'SB5', from: 'CONFIRMED', event: 'START', to: 'EXECUTING' },
    { id: 'SB6', from: 'EXECUTING', event: 'COMPLETE', to: 'DONE' },
    { id: 'SB7', from: 'EXECUTING', event: 'SWITCH_OFF', to: 'PARTIAL' },
    { id: 'SB8', from: 'PARTIAL', event: 'RESUME', to: 'EXECUTING' },
    { id: 'SB9', from: 'EXECUTING', event: 'TAKE_OVER', to: 'EXECUTING' },
  ],
} as const satisfies Contract;

it('[AC-B2-04d#1] 批次 YAML 恰含 SB1–SB9 九行，不含 SB10，状态值与资金契约一致', () => {
  assertDefinition(BATCH);
  const rows = machine(BATCH).transitions;
  expect(rows).toHaveLength(9);
  expect(rows.some((row) => row.from.includes('CONFIRMED') && row.event === 'MANUAL_START')).toBe(
    false,
  );
});

it('[AC-B2-04d#2] 批次由 YAML 生成，包入口和生成物的枚举、迁移表一致', () => {
  assertGenerated(BATCH);
});

it.each(BATCH.rows)('[AC-B2-04d#3] $id 接受 $from + $event → $to', ({ id, from, event, to }) => {
  for (const entry of ENTRIES) {
    expect(transition(BATCH, entry)(from, event)).toEqual({ ok: true, to, id, noop: false });
  }
});

it.each(illegalPairs(BATCH))(
  '[AC-B2-04d#4] 批次表外 $from + $event 返回 illegal（包括终态、未确认执行和非法取消）',
  ({ from, event }) => {
    for (const entry of ENTRIES) {
      expect(transition(BATCH, entry)(from, event)).toEqual(ILLEGAL);
    }
  },
);

it.each([null, ...BATCH.states])(
  '[AC-B2-04d#5] %s 的 SB10 手动开始恒拒：财务确认前不开放',
  (from) => {
    // SB10 不进入迁移表；包括 CONFIRMED 在内，所有状态均按表外事件拒绝。
    for (const entry of ENTRIES) {
      expect(transition(BATCH, entry)(from, 'MANUAL_START')).toEqual(ILLEGAL);
    }
  },
);

const GUARDS = [
  { id: 'SB1', terms: [/credit\.enabled/, /on/, /候选.*非空|非空.*候选/] },
  { id: 'SB2', terms: [/权限/, /step-up/, /定时/, /晚于确认/, /名义时段/] },
  { id: 'SB3', terms: [/定时/, /尚未开始|未开始执行/] },
  { id: 'SB4', terms: [/step-up/, /原因/] },
  {
    id: 'SB5',
    terms: [
      /已到执行时刻/,
      /快照/,
      /完成/,
      /超时/,
      /settle\.auto\.enabled/,
      /credit\.enabled/,
      /on/,
      /停住/,
      /没有|无.*标记|未.*标记/,
    ],
  },
  { id: 'SB8', terms: [/step-up/, /两个开关|settle\.auto\.enabled/, /on/, /快照/, /完成/, /超时/] },
  { id: 'SB9', terms: [/EXECUTING/, /没有存活|无存活/, /执行者/, /快照/, /完成/, /超时/] },
];

it.each(GUARDS)('[AC-B2-04d#6] $id 守卫保留 BR-FUND-04 前置条件', ({ id, terms }) => {
  const row = machine(BATCH).transitions.find((candidate) => candidate.id === id);
  expect(row).toBeDefined();
  for (const term of terms) expect(row?.guard).toMatch(term);
});

it('[AC-B2-04d#6] SB10 仅在 YAML 注释说明未开放，手动开始按表外事件拒绝', () => {
  const source = readRequired('specs/state-machines/settle-batch.yaml');
  expect(source).toMatch(/^\s*#\s*SB10 财务确认前不开放（BR-FUND-04），开放时另开任务加行\s*$/m);
  expect(machine(BATCH).transitions.some((row) => row.id === 'SB10')).toBe(false);
  for (const entry of ENTRIES) {
    expect(transition(BATCH, entry)('CONFIRMED', 'MANUAL_START')).toEqual(ILLEGAL);
  }
});

it.each(['', 'CANCEL', 'confirmed', '__proto__'])(
  '[AC-B2-04d#7] 运行时未知批次事件 %s 拒绝迁移',
  (event) => {
    for (const entry of ENTRIES) {
      expect(transition(BATCH, entry)('CONFIRMED', event)).toEqual(ILLEGAL);
    }
  },
);

it('[AC-B2-04d#8] 开关中断后只能手动继续，崩溃接管后可继续完成', () => {
  for (const entry of ENTRIES) {
    const move = transition(BATCH, entry);
    expect(move('EXECUTING', 'SWITCH_OFF')).toMatchObject({ ok: true, to: 'PARTIAL' });
    expect(move('PARTIAL', 'START')).toEqual(ILLEGAL);
    expect(move('PARTIAL', 'TAKE_OVER')).toEqual(ILLEGAL);
    expect(move('PARTIAL', 'RESUME')).toMatchObject({ ok: true, to: 'EXECUTING' });
    expect(move('EXECUTING', 'TAKE_OVER')).toEqual({
      ok: true,
      to: 'EXECUTING',
      id: 'SB9',
      noop: false,
    });
    expect(move('EXECUTING', 'COMPLETE')).toMatchObject({ ok: true, to: 'DONE' });
    expect(move('DONE', 'RESUME')).toEqual(ILLEGAL);
  }
});
