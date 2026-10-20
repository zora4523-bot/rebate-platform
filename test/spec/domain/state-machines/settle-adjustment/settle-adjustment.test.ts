import { expect, it } from 'vitest';
import {
  assertDefinition,
  assertGenerated,
  ENTRIES,
  ILLEGAL,
  illegalPairs,
  machine,
  transition,
  type Contract,
} from '../settle-batch/kit.ts';

// BR-FUND-09 ② / BR-CALC-23：只有正差进入审批，驳回及两类作废均为终态。
// SA 编号及英文事件名为本任务的技术命名；重算差额、授权、锁与记账由服务层落实。
const ADJUSTMENT = {
  name: 'settle-adjustment',
  prefix: 'SETTLE_ADJUSTMENT',
  functionName: 'transitionSettleAdjustment',
  enumName: 'settle_adjustment_status',
  states: ['pending', 'approved', 'rejected', 'voided_stale_seq', 'voided_by_clawback'],
  events: ['CREATE', 'APPROVE', 'REJECT', 'VOID_STALE_SEQ', 'VOID_BY_CLAWBACK'],
  rows: [
    { id: 'SA1', from: null, event: 'CREATE', to: 'pending' },
    { id: 'SA2', from: 'pending', event: 'APPROVE', to: 'approved' },
    { id: 'SA3', from: 'pending', event: 'REJECT', to: 'rejected' },
    { id: 'SA4', from: 'pending', event: 'VOID_STALE_SEQ', to: 'voided_stale_seq' },
    { id: 'SA5', from: 'pending', event: 'VOID_BY_CLAWBACK', to: 'voided_by_clawback' },
  ],
} as const satisfies Contract;

it('[AC-B2-04d#15] 补差候选只含契约五态，pending 可批准、驳回或按两种原因作废', () => {
  assertDefinition(ADJUSTMENT);
});

it('[AC-B2-04d#16] 补差状态机由 YAML 生成，包入口与生成物一致', () => {
  assertGenerated(ADJUSTMENT);
});

it.each(ADJUSTMENT.rows)(
  '[AC-B2-04d#17] $id 接受 $from + $event → $to',
  ({ id, from, event, to }) => {
    for (const entry of ENTRIES) {
      expect(transition(ADJUSTMENT, entry)(from, event)).toEqual({ ok: true, to, id, noop: false });
    }
  },
);

it.each(illegalPairs(ADJUSTMENT))(
  '[AC-B2-04d#18] 候选表外 $from + $event 拒绝（含重批、已批准后作废及终态重开）',
  ({ from, event }) => {
    for (const entry of ENTRIES) {
      expect(transition(ADJUSTMENT, entry)(from, event)).toEqual(ILLEGAL);
    }
  },
);

const GUARDS = [
  { id: 'SA1', terms: [/CREDITED/, /正差/, /seq/, /扣回/] },
  { id: 'SA2', terms: [/超管/, /权限/, /step-up/, /seq/, /当前/, /重算/, /0/, /审计/] },
  { id: 'SA3', terms: [/原因|理由/, /不记账|不写.*凭证/] },
  { id: 'SA4', terms: [/seq/, /不等|不一致|≠|!=|过期/, /不记账|不写.*凭证/] },
  {
    id: 'SA5',
    terms: [/扣回/, /settle\.adjust\.void_on_clawback\.enabled/, /on/, /同一事务|同事务/],
  },
];

it.each(GUARDS)('[AC-B2-04d#19] $id 保留正差审批、过期或扣回作废的条件', ({ id, terms }) => {
  const row = machine(ADJUSTMENT).transitions.find((candidate) => candidate.id === id);
  expect(row).toBeDefined();
  for (const term of terms) expect(row?.guard).toMatch(term);
});

it.each(['voided_stale_seq', 'voided_by_clawback'])(
  '[AC-B2-04d#20] %s 后的批准必须拒绝，作废原因不能互相覆盖',
  (state) => {
    for (const entry of ENTRIES) {
      const move = transition(ADJUSTMENT, entry);
      expect(move(state, 'APPROVE')).toEqual(ILLEGAL);
      expect(move(state, 'VOID_STALE_SEQ')).toEqual(ILLEGAL);
      expect(move(state, 'VOID_BY_CLAWBACK')).toEqual(ILLEGAL);
    }
  },
);

it.each(['AUTO_APPROVE', 'NEGATIVE_ADJUST', 'REOPEN', 'approve', '', '__proto__'])(
  '[AC-B2-04d#21] 候选未定义事件 %s 拒绝迁移',
  (event) => {
    for (const entry of ENTRIES) {
      for (const from of [null, ...ADJUSTMENT.states]) {
        expect(transition(ADJUSTMENT, entry)(from, event)).toEqual(ILLEGAL);
      }
    }
  },
);
