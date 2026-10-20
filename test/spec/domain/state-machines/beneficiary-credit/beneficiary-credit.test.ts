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

// BR-FUND-04 ⑫：新义务先 open；关闭后不能重开，同一受益人的新义务必须用新 ID。
// BC 编号及英文事件名为本任务的技术命名，不引入金额、凭证或数据库事务实现。
const CREDIT = {
  name: 'beneficiary-credit',
  prefix: 'BENEFICIARY_CREDIT',
  functionName: 'transitionBeneficiaryCredit',
  enumName: 'beneficiary_credit_status',
  states: ['open', 'done', 'forfeited', 'voided'],
  events: ['OPEN', 'COMPLETE', 'FORFEIT', 'VOID'],
  rows: [
    { id: 'BC1', from: null, event: 'OPEN', to: 'open' },
    { id: 'BC2', from: 'open', event: 'COMPLETE', to: 'done' },
    { id: 'BC3', from: 'open', event: 'FORFEIT', to: 'forfeited' },
    { id: 'BC4', from: 'open', event: 'VOID', to: 'voided' },
  ],
} as const satisfies Contract;

it('[AC-B2-04d#9] 待补记义务只有契约规定的四态与开立、完成、没收、作废迁移', () => {
  assertDefinition(CREDIT);
});

it('[AC-B2-04d#10] 义务由 YAML 生成，包入口与生成物一致', () => {
  assertGenerated(CREDIT);
});

it.each(CREDIT.rows)('[AC-B2-04d#11] $id 接受 $from + $event → $to', ({ id, from, event, to }) => {
  for (const entry of ENTRIES) {
    expect(transition(CREDIT, entry)(from, event)).toEqual({ ok: true, to, id, noop: false });
  }
});

it.each(illegalPairs(CREDIT))(
  '[AC-B2-04d#12] 义务表外 $from + $event 拒绝（含重复关闭、重开及终态互转）',
  ({ from, event }) => {
    for (const entry of ENTRIES) {
      expect(transition(CREDIT, entry)(from, event)).toEqual(ILLEGAL);
    }
  },
);

const GUARDS = [
  { id: 'BC1', terms: [/待补记/, /已有|最多一个|未完成义务/, /归属快照/] },
  { id: 'BC2', terms: [/补给|补记|入账/, /金额.*0|0.*金额/, /R9/, /R10/, /同一事务|同事务/] },
  { id: 'BC3', terms: [/归.*平台|没收/, /R9/, /R10/, /同一事务|同事务/] },
  { id: 'BC4', terms: [/CLAWED_BACK/, /改派/, /同一事务|同事务/] },
];

it.each(GUARDS)('[AC-B2-04d#13] $id 保留 BR-FUND-04 ⑫ 义务处置条件', ({ id, terms }) => {
  const row = machine(CREDIT).transitions.find((candidate) => candidate.id === id);
  expect(row).toBeDefined();
  for (const term of terms) expect(row?.guard).toMatch(term);
});

it.each(['DEFER', 'REOPEN', 'APPROVE', 'open', '', '__proto__'])(
  '[AC-B2-04d#14] 义务未定义事件 %s 不新增状态或重开义务',
  (event) => {
    for (const entry of ENTRIES) {
      for (const from of [null, ...CREDIT.states]) {
        expect(transition(CREDIT, entry)(from, event)).toEqual(ILLEGAL);
      }
    }
  },
);
