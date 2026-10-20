import { expect, it } from 'vitest';
import {
  MACHINES,
  renderStateMachine,
} from '../../../../packages/domain/scripts/state-machines.ts';
import { generatedExports, readRequired } from '../order/kit.ts';
import { GENERATED, ILLEGAL, LEGAL, SOURCE, machine, transitionOf } from './kit.ts';

it('[AC-B1-35a#7] 生成器自动发现 invite-reward，无需登记', () => {
  expect(MACHINES).toContain('invite-reward');
});

it('[AC-B1-35a#7] 生成物与 renderStateMachine 逐字一致，保留 YAML 全表', () => {
  const rendered = renderStateMachine(readRequired(SOURCE));
  expect(readRequired(GENERATED)).toBe(rendered);
  const doc = machine();
  const exports = generatedExports(rendered);
  expect(exports['INVITE_REWARD_STATES']).toEqual(doc.states);
  expect(exports['INVITE_REWARD_EVENTS']).toEqual(doc.events);
  expect(exports['INVITE_REWARD_TRANSITIONS']).toEqual(doc.transitions);
});

it('[AC-B1-35a#7] guard 中的可执行字样只作文字，不改变全部 18 个组合的结果', () => {
  const yaml = readRequired(SOURCE);
  const guard = 'throw new Error("guard must remain text")';
  const changed = yaml.replace(/^(\s*guard:)\s*[^\r\n]+/gm, `$1 '${guard}'`);
  expect(changed).not.toBe(yaml);
  const original = transitionOf(generatedExports(renderStateMachine(yaml)));
  const exports = generatedExports(renderStateMachine(changed));
  expect(exports['INVITE_REWARD_TRANSITIONS']).toEqual(
    machine().transitions.map((row) => ({ ...row, guard })),
  );
  const transition = transitionOf(exports);
  for (const { from, event, to, id, noop } of LEGAL) {
    const expected = { ok: true, to, id, noop };
    expect(original(from, event)).toEqual(expected);
    expect(transition(from, event)).toEqual(expected);
  }
  for (const { from, event } of ILLEGAL) {
    const expected = { ok: false, reason: 'illegal', id: null };
    expect(original(from, event)).toEqual(expected);
    expect(transition(from, event)).toEqual(expected);
  }
});
