import { expect, it } from 'vitest';
import {
  MACHINES,
  renderStateMachine,
} from '../../../../packages/domain/scripts/state-machines.ts';
import { generatedExports } from '../order/kit.ts';
import {
  GENERATED,
  ILLEGAL,
  LEGAL,
  machine,
  readRequired,
  transitionFunction,
  yamlText,
} from './kit.ts';

it('[AC-B1-15b#7] 自动发现 deletion-request，生成物与 render 逐字一致且保留全表', () => {
  expect(MACHINES).toContain('deletion-request');
  const rendered = renderStateMachine(yamlText());
  expect(readRequired(GENERATED)).toBe(rendered);
  const exports = generatedExports(rendered);
  const doc = machine();
  expect(exports['DELETION_REQUEST_STATES']).toEqual(doc.states);
  expect(exports['DELETION_REQUEST_EVENTS']).toEqual(doc.events);
  expect(exports['DELETION_REQUEST_TRANSITIONS']).toEqual(doc.transitions);
});

it('[AC-B1-15b#7] guard 即使包含可执行字样也只是文字，全部迁移结果不变', () => {
  const yaml = yamlText();
  const guard = 'throw new Error("guard must remain text")';
  const changed = yaml.replace(/^(\s*guard:)\s*[^\r\n]+/gm, `$1 '${guard}'`);
  expect(changed).not.toBe(yaml);
  const exports = generatedExports(renderStateMachine(changed));
  expect(exports['DELETION_REQUEST_TRANSITIONS']).toEqual(
    machine().transitions.map((row) => ({ ...row, guard })),
  );
  const original = transitionFunction(generatedExports(readRequired(GENERATED)));
  const transition = transitionFunction(exports);
  for (const row of LEGAL) {
    const expected = { ok: true, to: row.to, id: row.id, noop: false };
    expect(original(row.from, row.event)).toEqual(expected);
    expect(transition(row.from, row.event)).toEqual(expected);
  }
  for (const row of ILLEGAL) {
    const expected = { ok: false, reason: 'illegal', id: null };
    expect(original(row.from, row.event)).toEqual(expected);
    expect(transition(row.from, row.event)).toEqual(expected);
  }
});
