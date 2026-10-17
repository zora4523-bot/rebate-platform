import { expect, it } from 'vitest';
import { readRequired } from '../../../state-machines/order/kit.ts';
import { EVENTS, LEGAL, machine, publicExports, STATES } from './kit.ts';

it('[AC-B2-03j#1] YAML 只有三个状态、三个大写事件及指定的三行迁移', () => {
  const doc = machine();
  expect([...doc.states].sort()).toEqual([...STATES].sort());
  expect([...doc.events].sort()).toEqual([...EVENTS].sort());
  expect(doc.transitions).toHaveLength(3);
  expect(new Set(doc.transitions.map((row) => row.id)).size).toBe(3);
  const actual = doc.transitions.flatMap((row) =>
    row.from.map((from) => JSON.stringify({ from, event: row.event, to: row.to })),
  );
  expect(actual.sort()).toEqual(LEGAL.map((row) => JSON.stringify(row)).sort());
  for (const row of doc.transitions) {
    expect(row.kind === undefined || row.kind === 'transition').toBe(true);
    expect(row.id).toMatch(/^[A-Z][A-Za-z0-9]*$/);
    expect(row.test_id).toEqual(expect.any(String));
    expect(row.test_id.length).toBeGreaterThan(0);
    expect(row.guard).toEqual(expect.any(String));
  }
});

it('[AC-B2-03j#2] 状态集合与 0032 的 commission_rule_versions_status_check 一致', () => {
  const doc = machine();
  const sql = readRequired('db/migrations/0032_commission-rules.sql');
  const check =
    /CONSTRAINT\s+commission_rule_versions_status_check\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]+)\)\s*\)/i.exec(
      sql,
    );
  expect(check).not.toBeNull();
  const values = [...(check?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
  expect(values.sort()).toEqual([...STATES].sort());
  expect([...doc.states].sort()).toEqual(values);
  expect(publicExports()['COMMISSION_RULE_VERSION_STATES']).toEqual(doc.states);
});

it('[AC-B2-03j#3] 发布与撤销守卫保留规则文字，实际校验交给 B2-03k 服务层', () => {
  const doc = machine();
  const publish = doc.transitions.find((row) => row.event === 'PUBLISH');
  const revoke = doc.transitions.find((row) => row.event === 'REVOKE');
  expect(publish).toBeDefined();
  expect(revoke).toBeDefined();
  const publishGuard = publish?.guard ?? '';
  for (const term of ['BR-CALC-22', '完整性', '上限', '试算', 'step-up', 'effective_from']) {
    expect(publishGuard).toContain(term);
  }
  expect(publishGuard).toMatch(/≥|>=|不早于|大于等于/);
  expect(publishGuard).toMatch(/严格大于/);
  expect(publishGuard).toMatch(/已发布/);
  expect(publishGuard).toMatch(/未撤销/);
  expect(revoke?.guard).toContain('effective_from');
  expect(revoke?.guard).toMatch(/未到|未生效|尚未生效|早于|now\s*<|当前时刻\s*</);
});

it('[AC-B2-03j#4] 包入口导出的状态、事件与迁移表逐项等于 YAML', () => {
  const doc = machine();
  const exports = publicExports();
  expect(exports['COMMISSION_RULE_VERSION_STATES']).toEqual(doc.states);
  expect(exports['COMMISSION_RULE_VERSION_EVENTS']).toEqual(doc.events);
  expect(exports['COMMISSION_RULE_VERSION_TRANSITIONS']).toEqual(doc.transitions);
});
