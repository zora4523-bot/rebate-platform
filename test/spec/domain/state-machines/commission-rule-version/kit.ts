import * as domain from '@couli/domain';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../../tools/lib/yaml-lite.ts';
import { readRequired, type Machine } from '../../../state-machines/order/kit.ts';

export const NAME = 'commission-rule-version';
export const SOURCE = `specs/state-machines/${NAME}.yaml`;
export const TARGET = `packages/domain/src/state-machines/${NAME}.gen.ts`;
export const STATES = ['draft', 'published', 'revoked'] as const;
export const EVENTS = ['DRAFT_CREATED', 'PUBLISH', 'REVOKE'] as const;

// 独立于 YAML 的预期，来自 BR-CALC-11 / BR-CALC-22 与任务补充迁移表。
export const LEGAL = [
  { from: null, event: 'DRAFT_CREATED', to: 'draft' },
  { from: 'draft', event: 'PUBLISH', to: 'published' },
  { from: 'published', event: 'REVOKE', to: 'revoked' },
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
): (from: (typeof STATES)[number] | null, event: (typeof EVENTS)[number]) => unknown {
  // 不静态导入尚不存在的生成物；缺导出必须先报断言失败，不能变成 TypeError。
  const fn = exports['transitionCommissionRuleVersion'];
  expect(fn).toEqual(expect.any(Function));
  return fn as ReturnType<typeof transitionFunction>;
}
