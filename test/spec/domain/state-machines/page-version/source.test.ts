import { expect, it } from 'vitest';
import { readRequired } from '../../../state-machines/order/kit.ts';
import { EVENTS, LEGAL, machine, publicExports, STATES } from './kit.ts';

it('[AC-F1-09h#1] YAML 只含三个状态、三个事件及 P1/P2/P3 三行迁移', () => {
  const doc = machine();
  expect([...doc.states].sort()).toEqual([...STATES].sort());
  expect([...doc.events].sort()).toEqual([...EVENTS].sort());
  expect(doc.transitions).toHaveLength(3);
  const actual = doc.transitions.flatMap((row) =>
    row.from.map((from) => ({ id: row.id, from, event: row.event, to: row.to })),
  );
  expect(actual.sort((a, b) => a.id.localeCompare(b.id))).toEqual(LEGAL);
  for (const row of doc.transitions) {
    expect(row.kind === undefined || row.kind === 'transition').toBe(true);
    expect(row).not.toHaveProperty('alternatives');
    expect(row.test_id).toMatch(/^AC-F1-09h#[1-9]\d*$/);
    expect(row.guard).toEqual(expect.any(String));
    expect(row.guard.trim().length).toBeGreaterThan(0);
  }
  expect(doc).not.toHaveProperty('stages');
  expect(doc).not.toHaveProperty('event_states');
});

it('[AC-F1-09h#2] YAML 与公开状态集合均匹配 0039 的 page_versions_status_check', () => {
  const doc = machine();
  const sql = readRequired('db/migrations/0039_pages.sql');
  const check =
    /CONSTRAINT\s+page_versions_status_check\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]+)\)\s*\)/i.exec(
      sql,
    );
  expect(check).not.toBeNull();
  const values = [...(check?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
  expect(values.sort()).toEqual([...STATES].sort());
  expect([...doc.states].sort()).toEqual(values);
  expect(publicExports()['PAGE_VERSION_STATES']).toEqual(doc.states);
});

it('[AC-F1-09h#3] 包入口导出 YAML 的状态、事件和完整迁移表', () => {
  const doc = machine();
  const exports = publicExports();
  expect(exports['PAGE_VERSION_STATES']).toEqual(doc.states);
  expect(exports['PAGE_VERSION_EVENTS']).toEqual(doc.events);
  expect(exports['PAGE_VERSION_TRANSITIONS']).toEqual(doc.transitions);
});
