import { expect, it } from 'vitest';
import {
  MACHINES,
  renderStateMachine,
} from '../../../../../packages/domain/scripts/state-machines.ts';
import { generatedExports, readRequired } from '../../../state-machines/order/kit.ts';
import { EVENTS, LEGAL, NAME, SOURCE, STATES, TARGET, transitionFunction } from './kit.ts';

it('[AC-F1-09h#8] 自动发现 page-version，并保留已登记的状态机', () => {
  expect(MACHINES).toContain(NAME);
  for (const name of ['commission-rule-version', 'order-platform', 'order-rebate', 'withdrawal']) {
    expect(MACHINES).toContain(name);
  }
  expect(new Set(MACHINES).size).toBe(MACHINES.length);
});

it('[AC-F1-09h#9] render 稳定且与生成物逐字一致，生成表保持合法迁移', () => {
  const yaml = readRequired(SOURCE);
  const actual = renderStateMachine(yaml);
  expect(actual).toBe(readRequired(TARGET));
  expect(renderStateMachine(yaml)).toBe(actual);
  expect(actual).toContain('生成物，勿手改');
  expect(actual).toContain(SOURCE);
  const exports = generatedExports(actual);
  expect(exports['PAGE_VERSION_STATES']).toEqual(STATES);
  expect(exports['PAGE_VERSION_EVENTS']).toEqual(EVENTS);
  const transition = transitionFunction(exports);
  for (const row of LEGAL) {
    expect(transition(row.from, row.event)).toEqual({
      ok: true,
      to: row.to,
      id: row.id,
      noop: false,
    });
  }
});

it('[AC-F1-09h#10] 守卫只保留文字，不由生成的 transition 执行', () => {
  const yaml = readRequired(SOURCE);
  const guard = 'throw new Error("guard must remain text")';
  // 用实际任务 YAML 改守卫，验证渲染行为；权限、CAS、发布信息、自动回滚阈值由 F1-09f 负责。
  const changed = yaml.replace(/^(\s*guard:)\s*[^\r\n]+/gm, `$1 '${guard}'`);
  expect(changed).not.toBe(yaml);
  const exports = generatedExports(renderStateMachine(changed));
  expect(exports['PAGE_VERSION_TRANSITIONS']).toEqual(
    expect.arrayContaining(LEGAL.map((row) => expect.objectContaining({ id: row.id, guard }))),
  );
  const transition = transitionFunction(exports);
  for (const row of LEGAL) {
    expect(transition(row.from, row.event)).toEqual({
      ok: true,
      to: row.to,
      id: row.id,
      noop: false,
    });
  }
});
