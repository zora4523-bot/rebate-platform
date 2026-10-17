import { expect, it } from 'vitest';
import { renderStateMachine } from '../../../../packages/domain/scripts/state-machines.ts';
import { STATES } from './cases.ts';
import {
  GENERATED,
  generatedExports,
  machine,
  readRequired,
  transitionOf,
  yamlText,
} from './kit.ts';

it('[AC-CT-04d#9] 复用生成器，输出稳定且与入库文本逐字一致', () => {
  const yaml = yamlText();
  const generated = readRequired(GENERATED);
  expect(renderStateMachine(yaml)).toBe(generated);
  expect(renderStateMachine(yaml)).toBe(renderStateMachine(yaml));
  const exports = generatedExports(generated);
  expect(exports['WITHDRAWAL_STATES']).toEqual(STATES);
  expect(exports['WITHDRAWAL_EVENTS']).toEqual(machine().events);
  expect(exports['WITHDRAWAL_TRANSITIONS']).toEqual(machine().transitions);
  expect(transitionOf(exports)(null, 'APPLY')).toStrictEqual({
    ok: true,
    to: 'PENDING_REVIEW',
    id: 'W1',
    noop: false,
  });
});

it('[AC-CT-04d#10] 改变输入目标会改变输出与迁移结果，不能写死提现文件', () => {
  const yaml = yamlText();
  // 仅为合成结构变异，不是新增业务迁移。
  const changed = yaml.replace(/to: PENDING_REVIEW\b/, 'to: APPROVED');
  expect(changed).not.toBe(yaml);
  const first = renderStateMachine(yaml);
  const second = renderStateMachine(changed);
  expect(second).not.toBe(first);
  expect(transitionOf(generatedExports(first))(null, 'APPLY')).toStrictEqual({
    ok: true,
    to: 'PENDING_REVIEW',
    id: 'W1',
    noop: false,
  });
  expect(transitionOf(generatedExports(second))(null, 'APPLY')).toStrictEqual({
    ok: true,
    to: 'APPROVED',
    id: 'W1',
    noop: false,
  });
});

it('[AC-CT-04d#11] 守卫仅是文字，不求值 needs_manual、资金校验或开关', () => {
  const yaml = yamlText();
  const guard = 'BR-WDR-03 全部通过；missingContext.allowed()';
  const changed = yaml.replace(/^(\s+guard:.*)BR-WDR-03 全部通过/m, `$1${guard}`);
  expect(changed).not.toBe(yaml);
  const exports = generatedExports(renderStateMachine(changed));
  expect(exports['WITHDRAWAL_TRANSITIONS']).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'W1', guard: expect.stringContaining(guard) }),
    ]),
  );
  const transition = transitionOf(exports);
  expect(transition(null, 'APPLY')).toStrictEqual({
    ok: true,
    to: 'PENDING_REVIEW',
    id: 'W1',
    noop: false,
  });
  expect(transition('PAYING', 'CHANNEL_SUCCESS')).toStrictEqual({
    ok: true,
    to: 'PAID_API',
    id: 'W5',
    noop: false,
  });
  expect(transition('APPROVED', 'CHANNEL_SUCCESS_PROVEN')).toStrictEqual({
    ok: true,
    to: 'PAID_API',
    id: 'W11',
    noop: false,
  });
});
