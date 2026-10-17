import * as domain from '@couli/domain';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { readRequired, type Machine } from '../order/kit.ts';

export const SOURCE = 'specs/state-machines/withdrawal.yaml';
export const GENERATED = 'packages/domain/src/state-machines/withdrawal.gen.ts';
export { generatedExports, readRequired, repoFile } from '../order/kit.ts';

export function yamlText(): string {
  return readRequired(SOURCE);
}

export function machine(): Machine {
  const parsed = parseYamlLite(yamlText());
  expect(parsed).toEqual(
    expect.objectContaining({
      name: expect.any(String),
      field: expect.any(String),
      states: expect.any(Array),
      events: expect.any(Array),
      transitions: expect.any(Array),
    }),
  );
  return parsed as Machine;
}

export type Transition = (from: string | null, event: string) => unknown;

export function transitionOf(exports: Record<string, unknown>): Transition {
  expect(exports['transitionWithdrawal'], '必须导出 transitionWithdrawal').toEqual(
    expect.any(Function),
  );
  return exports['transitionWithdrawal'] as Transition;
}

export function publicTransition(): Transition {
  // 不静态导入尚不存在的命名导出，先红只能来自存在性断言。
  return transitionOf(domain);
}
