import * as domain from '@couli/domain';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { generatedExports, readRequired, type Machine } from '../order/kit.ts';

export const SOURCE = 'specs/state-machines/invite-reward.yaml';
export const GENERATED = 'packages/domain/src/state-machines/invite-reward.gen.ts';
export const STATES = ['qualified', 'deferred', 'processed', 'voided', 'budget_exhausted'];
export const EVENTS = ['DEFER', 'PROCESS', 'VOID'];

// 独立预期来自 B1-35a §9.2 迁移表及 §9.3 复核，不从 YAML / 生成物推算。
export const ROWS = [
  { id: 'R1', from: ['qualified'], event: 'DEFER', to: 'deferred' },
  { id: 'R2', from: ['deferred'], event: 'DEFER', to: 'same' },
  { id: 'R3', from: ['qualified', 'deferred'], event: 'PROCESS', to: 'processed' },
  { id: 'R4', from: ['qualified', 'deferred'], event: 'VOID', to: 'voided' },
];
export const LEGAL = [
  { id: 'R1', from: 'qualified', event: 'DEFER', to: 'deferred', noop: false },
  { id: 'R2', from: 'deferred', event: 'DEFER', to: 'deferred', noop: true },
  { id: 'R3', from: 'qualified', event: 'PROCESS', to: 'processed', noop: false },
  { id: 'R3', from: 'deferred', event: 'PROCESS', to: 'processed', noop: false },
  { id: 'R4', from: 'qualified', event: 'VOID', to: 'voided', noop: false },
  { id: 'R4', from: 'deferred', event: 'VOID', to: 'voided', noop: false },
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
    states: expect.any(Array),
    events: expect.any(Array),
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
  const fn = exports['transitionInviteReward'];
  // 缺少导出必须产生断言失败，避免静态导入失败或 TypeError 造成无效先红。
  expect(fn, '包入口和生成物均须导出 transitionInviteReward').toEqual(expect.any(Function));
  return fn as ReturnType<typeof transitionOf>;
}

export const ENTRIES = [
  { name: '包入口', load: publicExports },
  { name: '生成物', load: () => generatedExports(readRequired(GENERATED)) },
];
