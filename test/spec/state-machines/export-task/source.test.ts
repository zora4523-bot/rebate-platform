import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { readRequired } from '../order/kit.ts';
import { edgeKeys, EDGES, EVENTS, machine, publicExports, STATES } from './kit.ts';

it('[AC-B1-34g#1] YAML 状态与 export_status 六值逐值一致且无重复', () => {
  const doc = machine();
  const parsed = parseYamlLite(readRequired('contracts/enums/admin.yaml'));
  expect(parsed).toMatchObject({
    enums: { export_status: { values: expect.any(Object) } },
  });
  const contract = parsed as { enums: { export_status: { values: Record<string, unknown> } } };
  const values = Object.keys(contract.enums.export_status.values).sort();
  expect(values).toEqual([...STATES].sort());
  expect([...doc.states].sort()).toEqual(values);
});

it('[AC-B1-34g#2] YAML 恰含六个事件和七条边，每行都有迁移编号和测试 ID', () => {
  const doc = machine();
  expect([...doc.events].sort()).toEqual([...EVENTS].sort());
  for (const row of doc.transitions) {
    expect(row.from).toEqual(expect.any(Array));
    expect(row.from.length).toBeGreaterThan(0);
    expect(row.id).toEqual(expect.stringMatching(/\S/));
    expect(row.test_id).toEqual(expect.stringMatching(/\S/));
    expect(row.guard).toEqual(expect.stringMatching(/\S/));
    expect(row).not.toHaveProperty('kind');
    expect(row).not.toHaveProperty('alternatives');
  }
  expect(new Set(doc.transitions.map((row) => row.id)).size).toBe(doc.transitions.length);
  expect(doc).not.toHaveProperty('stages');
  expect(doc).not.toHaveProperty('event_states');
  const edges = doc.transitions.flatMap((row) =>
    row.from.map((from) => ({ from, event: row.event, to: row.to })),
  );
  expect(edgeKeys(edges)).toEqual(edgeKeys(EDGES));
});

it('[AC-B1-34g#4] expired 和 cancelled 在 YAML 中没有出边', () => {
  const doc = machine();
  expect(doc.states).toEqual(expect.arrayContaining(['expired', 'cancelled']));
  expect(
    doc.transitions.filter((row) =>
      row.from.some((from) => from === 'expired' || from === 'cancelled'),
    ),
  ).toEqual([]);
});

it('[AC-B1-34g#5] 包入口公开 YAML 的完整状态、事件和迁移表', () => {
  const doc = machine();
  const exports = publicExports();
  expect(exports['EXPORT_TASK_STATES']).toEqual(doc.states);
  expect(exports['EXPORT_TASK_EVENTS']).toEqual(doc.events);
  expect(exports['EXPORT_TASK_TRANSITIONS']).toEqual(doc.transitions);
});
