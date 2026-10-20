import * as domain from '@couli/domain';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { generatedExports, readRequired, type Machine } from '../order/kit.ts';

export const SOURCE = 'specs/state-machines/invite-reward.yaml';
export const GENERATED = 'packages/domain/src/state-machines/invite-reward.gen.ts';
export const STATES = ['qualified', 'deferred', 'processed', 'voided', 'expired'];
export const EVENTS = ['DEFER', 'PROCESS', 'VOID', 'EXPIRE'];

// 独立预期来自 B1-35a §9.2、§9.3 及 §10、§11（SPEC_REF ac4d993），不从 YAML / 生成物推算。
// BR-INV-24「有效期」：到期后无期内自购单，或期内自购单全部 VOID / B=0，才由每日任务判过期；
// 期内订单尚未有结果则等待。期限后才月结入账照发，因此已经触发、只等预算的 deferred 不 EXPIRE；
// 其触发单后续被扣回 / 维权仍按第 3 步 VOID。时间、订单事实与释放占用由 B1-35 判断，不在这里求值。
export const ROWS = [
  { id: 'R1', from: ['qualified'], event: 'DEFER', to: 'deferred' },
  { id: 'R2', from: ['deferred'], event: 'DEFER', to: 'same' },
  { id: 'R3', from: ['qualified', 'deferred'], event: 'PROCESS', to: 'processed' },
  { id: 'R4', from: ['qualified', 'deferred'], event: 'VOID', to: 'voided' },
  { id: 'R5', from: ['qualified'], event: 'EXPIRE', to: 'expired' },
];
export const LEGAL = [
  { id: 'R1', from: 'qualified', event: 'DEFER', to: 'deferred', noop: false },
  { id: 'R2', from: 'deferred', event: 'DEFER', to: 'deferred', noop: true },
  { id: 'R3', from: 'qualified', event: 'PROCESS', to: 'processed', noop: false },
  { id: 'R3', from: 'deferred', event: 'PROCESS', to: 'processed', noop: false },
  { id: 'R4', from: 'qualified', event: 'VOID', to: 'voided', noop: false },
  { id: 'R4', from: 'deferred', event: 'VOID', to: 'voided', noop: false },
  { id: 'R5', from: 'qualified', event: 'EXPIRE', to: 'expired', noop: false },
];
export const ILLEGAL = [null, ...STATES].flatMap((from) =>
  EVENTS.filter((event) => !LEGAL.some((row) => row.from === from && row.event === event)).map(
    (event) => ({ from, event }),
  ),
);

export function machine(): Machine {
  const parsed = parseYamlLite(readRequired(SOURCE));
  expect(parsed).toMatchObject({
    name: 'invite-reward',
    field: 'status',
    // 所有一致性 / CLI 用例都要使用新规格，避免旧 YAML 与旧生成物彼此一致而误报通过。
    states: STATES,
    events: EVENTS,
    transitions: expect.any(Array),
  });
  return parsed as Machine;
}

export function publicExports(): Record<string, unknown> {
  return domain;
}

export function transitionOf(
  exports: Record<string, unknown>,
): (from: string | null, event: string) => unknown {
  // 迁移函数与同一入口的状态、事件声明必须一起支持含 EXPIRE 的当前契约。
  expect(exports['INVITE_REWARD_STATES']).toEqual(STATES);
  expect(exports['INVITE_REWARD_EVENTS']).toEqual(EVENTS);
  const fn = exports['transitionInviteReward'];
  // 缺少导出必须产生断言失败，避免静态导入失败或 TypeError 造成无效先红。
  expect(fn, '包入口和生成物均须导出 transitionInviteReward').toEqual(expect.any(Function));
  return fn as ReturnType<typeof transitionOf>;
}

export const ENTRIES = [
  { name: '包入口', load: publicExports },
  { name: '生成物', load: () => generatedExports(readRequired(GENERATED)) },
];
