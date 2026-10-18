import * as domain from '@couli/domain';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../../tools/lib/yaml-lite.ts';
import { generatedExports, readRequired, type Machine } from '../../../state-machines/order/kit.ts';

export const NAME = 'page-version';
export const SOURCE = `specs/state-machines/${NAME}.yaml`;
export const TARGET = `packages/domain/src/state-machines/${NAME}.gen.ts`;
export const STATES = ['draft', 'published', 'rolled_back'] as const;
export const EVENTS = ['DRAFT_SAVED', 'PUBLISH', 'ROLLBACK'] as const;

// 独立预期来自任务 §9.2，不从待测 YAML 或生成表推导。
export const LEGAL = [
  { id: 'P1', from: null, event: 'DRAFT_SAVED', to: 'draft' },
  { id: 'P2', from: 'draft', event: 'PUBLISH', to: 'published' },
  { id: 'P3', from: 'published', event: 'ROLLBACK', to: 'rolled_back' },
] as const;

export function machine(): Machine {
  const parsed = parseYamlLite(readRequired(SOURCE));
  expect(parsed).toMatchObject({
    name: NAME,
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

export function transitionFunction(
  exports: Record<string, unknown>,
): (from: unknown, event: unknown) => unknown {
  // §9.9：不手写生成物；缺公开导出先报断言失败，避免 TypeError 或模块加载失败。
  const fn = exports['transitionPageVersion'];
  expect(fn).toEqual(expect.any(Function));
  return fn as ReturnType<typeof transitionFunction>;
}

export const ENTRIES = [
  { name: '包入口', load: publicExports },
  { name: '生成物', load: () => generatedExports(readRequired(TARGET)) },
];
