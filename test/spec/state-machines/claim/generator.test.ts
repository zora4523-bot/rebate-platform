import { expect, it } from 'vitest';
import {
  MACHINES,
  renderStateMachine,
} from '../../../../packages/domain/scripts/state-machines.ts';
import { generatedExports, readRequired } from '../order/kit.ts';
import { machine, source, SPECS, target, transitionFunction } from './kit.ts';

it.each(SPECS)('[CT-04e#5] 生成器自动发现 $name', (spec) => {
  expect(MACHINES).toContain(spec.name);
});

it.each(SPECS)('[CT-04e#6] $name 生成物与 render 输出一致，保留 YAML 全表', (spec) => {
  const yaml = readRequired(source(spec));
  const rendered = renderStateMachine(yaml);
  expect(readRequired(target(spec))).toBe(rendered);
  const doc = machine(spec);
  const exports = generatedExports(rendered);
  expect(exports[`${spec.prefix}_STATES`]).toEqual(doc.states);
  expect(exports[`${spec.prefix}_EVENTS`]).toEqual(doc.events);
  expect(exports[`${spec.prefix}_TRANSITIONS`]).toEqual(doc.transitions);
});

it.each(SPECS)('[CT-04e#7] $name 守卫只作文字，不在 transition 中求值', (spec) => {
  const yaml = readRequired(source(spec));
  const guard = 'throw new Error("guard must remain text")';
  const changed = yaml.replace(/^(\s*guard:)\s*[^\r\n]+/gm, `$1 '${guard}'`);
  expect(changed).not.toBe(yaml);
  const exports = generatedExports(renderStateMachine(changed));
  expect(exports[`${spec.prefix}_TRANSITIONS`]).toEqual(
    expect.arrayContaining(spec.legal.map((row) => expect.objectContaining({ id: row.id, guard }))),
  );
  const transition = transitionFunction(exports, spec);
  for (const row of spec.legal) {
    expect(transition(row.from, row.event)).toEqual({
      ok: true,
      to: row.to,
      id: row.id,
      noop: false,
    });
  }
});
