import * as domain from '@couli/domain';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { generatedExports, readRequired, type Machine } from '../order/kit.ts';

export { readRequired, repoFile } from '../order/kit.ts';

export const SOURCE = 'specs/state-machines/deletion-request.yaml';
export const GENERATED = 'packages/domain/src/state-machines/deletion-request.gen.ts';

// 独立预期来自 B1-15b §9.2–9.3，不从 YAML 或生成表反推。
// 只检查迁移拓扑与一致性；时间、余额、提现终态和 CAS 的执行归服务层后续任务。
export const STATES = ['cooling', 'processing', 'done', 'cancelled'] as const;
export const EVENTS = ['PROCESS', 'COMPLETE', 'CANCEL'] as const;
export const LEGAL = [
  { id: 'D1', from: 'cooling', event: 'PROCESS', to: 'processing' },
  { id: 'D2', from: 'processing', event: 'COMPLETE', to: 'done' },
  { id: 'D3', from: 'cooling', event: 'CANCEL', to: 'cancelled' },
] as const;

export const ILLEGAL = [null, ...STATES].flatMap((from) =>
  EVENTS.filter((event) => !LEGAL.some((row) => row.from === from && row.event === event)).map(
    (event) => ({ from, event }),
  ),
);

export function yamlText(): string {
  return readRequired(SOURCE);
}

export function machine(): Machine {
  const parsed = parseYamlLite(yamlText());
  expect(parsed).toMatchObject({
    name: 'deletion-request',
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
): (from: string | null, event: string) => unknown {
  const fn = exports['transitionDeletionRequest'];
  // 缺失导出先断言，避免模块加载错误或 TypeError 被误认作先红。
  expect(fn).toEqual(expect.any(Function));
  return fn as ReturnType<typeof transitionFunction>;
}

export const ENTRIES = [
  { name: '包入口', load: publicExports },
  { name: '生成物', load: () => generatedExports(readRequired(GENERATED)) },
];
