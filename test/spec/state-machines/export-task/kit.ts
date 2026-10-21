import * as domain from '@couli/domain';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { generatedExports, readRequired, type Machine } from '../order/kit.ts';

// 独立预期来自 B1-34g §9 / CT-24k，不能从待测 YAML 或生成表推导。
export const STATES = ['pending', 'running', 'done', 'failed', 'expired', 'cancelled'] as const;
export const EVENTS = ['START', 'COMPLETE', 'FAIL', 'EXPIRE', 'CANCEL', 'RETRY'] as const;
export const EDGES = [
  { from: 'pending', event: 'START', to: 'running' },
  { from: 'running', event: 'COMPLETE', to: 'done' },
  { from: 'running', event: 'FAIL', to: 'failed' },
  { from: 'done', event: 'EXPIRE', to: 'expired' },
  { from: 'pending', event: 'CANCEL', to: 'cancelled' },
  { from: 'running', event: 'CANCEL', to: 'cancelled' },
  { from: 'failed', event: 'RETRY', to: 'pending' },
] as const;
export const SOURCE = 'specs/state-machines/export-task.yaml';
export const TARGET = 'packages/domain/src/state-machines/export-task.gen.ts';

export function machine(): Machine {
  const parsed = parseYamlLite(readRequired(SOURCE));
  expect(parsed).toMatchObject({
    name: 'export-task',
    field: 'status',
    states: expect.any(Array),
    events: expect.any(Array),
    transitions: expect.any(Array),
  });
  return parsed as Machine;
}

export function edgeKeys(
  edges: readonly { from: string | null; event: string | null | undefined; to: string }[],
): string[] {
  return edges.map(({ from, event, to }) => JSON.stringify([from, event, to])).sort();
}

export function publicExports(): Record<string, unknown> {
  return domain;
}

export const ENTRIES = [
  { name: '包入口', load: publicExports },
  { name: '生成物', load: () => generatedExports(readRequired(TARGET)) },
];

export function transitionFunction(
  exports: Record<string, unknown>,
): (from: unknown, event: unknown) => unknown {
  const fn = exports['transitionExportTask'];
  // 先断言再调用：未导出函数不能以 TypeError 或模块加载错误冒充先红。
  expect(fn).toEqual(expect.any(Function));
  return fn as ReturnType<typeof transitionFunction>;
}
