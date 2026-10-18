import * as domain from '@couli/domain';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../../tools/lib/yaml-lite.ts';
import { generatedExports, readRequired, type Machine } from '../../../state-machines/order/kit.ts';

export const NAME = 'article-version';
export const SOURCE = `specs/state-machines/${NAME}.yaml`;
export const TARGET = `packages/domain/src/state-machines/${NAME}.gen.ts`;
export const STATES = ['draft', 'published', 'offline'] as const;
export const EVENTS = ['DRAFT_SAVED', 'PUBLISH', 'OFFLINE'] as const;

// 独立预期来自 F1-02u 任务书 §9.2 的编排默认，不从待测表推导。
export const LEGAL = [
  { id: 'A1', from: null, event: 'DRAFT_SAVED', to: 'draft' },
  { id: 'A2', from: 'draft', event: 'PUBLISH', to: 'published' },
  { id: 'A3', from: 'published', event: 'OFFLINE', to: 'offline' },
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
  // §9.9 禁止测试阶段手写生成物；先断言导出存在，缺实现时不得以 TypeError 报红。
  const fn = exports['transitionArticleVersion'];
  expect(fn).toEqual(expect.any(Function));
  return fn as ReturnType<typeof transitionFunction>;
}

export const ENTRIES = [
  { name: '包入口', load: publicExports },
  { name: '生成物', load: () => generatedExports(readRequired(TARGET)) },
];
