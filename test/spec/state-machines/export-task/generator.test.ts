import { expect, it } from 'vitest';
import {
  MACHINES,
  renderStateMachine,
} from '../../../../packages/domain/scripts/state-machines.ts';
import { generatedExports, readRequired } from '../order/kit.ts';
import { machine, SOURCE, TARGET } from './kit.ts';

it('[AC-B1-34g#5] 共用生成器自动发现 export-task', () => {
  expect(MACHINES).toContain('export-task');
});

it('[AC-B1-34g#5] 生成文件逐字等于 YAML 的生成结果且完整保留迁移表', () => {
  const yaml = readRequired(SOURCE);
  const rendered = renderStateMachine(yaml);
  expect(readRequired(TARGET)).toBe(rendered);
  const doc = machine();
  const exports = generatedExports(rendered);
  expect(exports['EXPORT_TASK_STATES']).toEqual(doc.states);
  expect(exports['EXPORT_TASK_EVENTS']).toEqual(doc.events);
  expect(exports['EXPORT_TASK_TRANSITIONS']).toEqual(doc.transitions);
});
