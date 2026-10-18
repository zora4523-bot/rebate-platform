import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { readRequired } from '../order/kit.ts';
import { machine, publicExports, rowKeys, SPECS } from './kit.ts';

it.each(SPECS)('[CT-04e#1] $name 状态、事件和迁移与独立预期集合相等', (spec) => {
  const doc = machine(spec);
  expect([...doc.states].sort()).toEqual([...spec.states].sort());
  expect([...doc.events].sort()).toEqual([...spec.events].sort());
  expect(doc.transitions).toHaveLength(spec.rowCount);
  expect(new Set(doc.transitions.map((row) => row.id)).size).toBe(spec.rowCount);
  for (const row of doc.transitions) {
    expect(row.from).toEqual(expect.any(Array));
    expect(row.from.length).toBeGreaterThan(0);
    expect(row.event).toEqual(expect.any(String));
    expect(row.guard).toEqual(expect.any(String));
    expect(row.guard.trim().length).toBeGreaterThan(0);
    expect(row.test_id).toBe(`${spec.testPrefix}-${row.id}`);
    expect(row).not.toHaveProperty('kind');
    expect(row).not.toHaveProperty('alternatives');
  }
  expect(doc).not.toHaveProperty('stages');
  expect(doc).not.toHaveProperty('event_states');
  const actual = doc.transitions.flatMap((row) =>
    row.from.map((from) => ({ id: row.id, from, event: row.event as string, to: row.to })),
  );
  expect(rowKeys(actual)).toEqual(rowKeys(spec.legal));
});

it.each(SPECS)('[CT-04e#2] $name 状态集合与契约枚举逐值相同', (spec) => {
  const doc = machine(spec);
  const parsed = parseYamlLite(readRequired('contracts/enums/order.yaml'));
  expect(parsed).toMatchObject({
    enums: { [spec.enumName]: { values: expect.any(Object) } },
  });
  const contract = parsed as { enums: Record<string, { values: Record<string, unknown> }> };
  const values = Object.keys(contract.enums[spec.enumName]!.values).sort();
  expect(values).toEqual([...spec.states].sort());
  expect([...doc.states].sort()).toEqual(values);
});

it.each(SPECS)('[CT-04e#3] $name 包入口导出 YAML 的状态、事件与完整迁移表', (spec) => {
  const doc = machine(spec);
  const exports = publicExports();
  expect(exports[`${spec.prefix}_STATES`]).toEqual(doc.states);
  expect(exports[`${spec.prefix}_EVENTS`]).toEqual(doc.events);
  expect(exports[`${spec.prefix}_TRANSITIONS`]).toEqual(doc.transitions);
});
