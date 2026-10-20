import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import {
  EVENTS,
  LEGAL,
  STATES,
  machine,
  publicExports,
  readRequired,
  transitionFunction,
} from './kit.ts';

it('[AC-B1-15b#1] YAML 只有 D1–D3，插入不是迁移，原因不拆事件', () => {
  const doc = machine();
  expect(Object.keys(doc).sort()).toEqual(['events', 'field', 'name', 'states', 'transitions']);
  expect(doc.states).toEqual(STATES);
  expect(doc.events).toEqual(EVENTS);
  expect(doc.transitions).toHaveLength(3);
  const actual = doc.transitions.map((row) => {
    expect(Object.keys(row).sort()).toEqual(['event', 'from', 'guard', 'id', 'test_id', 'to']);
    expect(row.from).toHaveLength(1);
    expect(row.from).not.toContain(null);
    expect(row.guard).toEqual(expect.any(String));
    expect(row.guard.trim().length).toBeGreaterThan(0);
    expect(row.test_id).toBe(`SM-DEL-${row.id}`);
    return { id: row.id, from: row.from[0], event: row.event, to: row.to };
  });
  expect(actual.sort((a, b) => a.id.localeCompare(b.id))).toEqual(LEGAL);
});

it('[AC-B1-15b#2] 状态与 identity 契约及 0059 CHECK 相同，撤回原因不进状态或事件', () => {
  const doc = machine();
  const parsed = parseYamlLite(readRequired('contracts/enums/identity.yaml'));
  expect(parsed).toMatchObject({
    enums: {
      deletion_status: { values: expect.any(Object) },
      deletion_cancel_reason: { values: expect.any(Object) },
    },
  });
  const contract = parsed as {
    enums: {
      deletion_status: { values: Record<string, unknown> };
      deletion_cancel_reason: { values: Record<string, unknown> };
    };
  };
  const statuses = Object.keys(contract.enums.deletion_status.values);
  expect(statuses).toEqual(STATES);
  expect(doc.states).toEqual(statuses);
  const sql = readRequired('db/migrations/0059_deletion-requests.sql').replace(/--[^\n]*/g, '');
  const check =
    /CONSTRAINT\s+deletion_requests_status_check\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]+)\)\s*\)/i.exec(
      sql,
    );
  expect(check, '须读取命名 CHECK 的真实取值').not.toBeNull();
  const dbStates = [...check![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  expect(dbStates.sort()).toEqual([...STATES].sort());
  expect([...doc.states].sort()).toEqual(dbStates);
  const reasons = Object.keys(contract.enums.deletion_cancel_reason.values);
  expect(reasons.sort()).toEqual(['negative_balance', 'user']);
  for (const reason of reasons) {
    expect(doc.states).not.toContain(reason);
    expect(doc.events.map((event) => event.toLowerCase())).not.toContain(reason);
  }
});

it('[AC-B1-15b#3] 包入口导出独立预期枚举、完整 YAML 迁移表和 transition', () => {
  const exports = publicExports();
  expect(exports['DELETION_REQUEST_STATES']).toEqual(STATES);
  expect(exports['DELETION_REQUEST_EVENTS']).toEqual(EVENTS);
  const doc = machine();
  expect(exports['DELETION_REQUEST_STATES']).toEqual(doc.states);
  expect(exports['DELETION_REQUEST_EVENTS']).toEqual(doc.events);
  expect(exports['DELETION_REQUEST_TRANSITIONS']).toEqual(doc.transitions);
  expect(transitionFunction(exports)).toEqual(expect.any(Function));
});

it('[AC-B1-15b#6] done/cancelled 是终态，各目标只由指定迁移进入', () => {
  const doc = machine();
  for (const terminal of ['done', 'cancelled']) {
    expect(doc.transitions.filter((row) => row.from.includes(terminal))).toEqual([]);
  }
  for (const { id, to } of LEGAL) {
    expect(doc.transitions.filter((row) => row.to === to).map((row) => row.id)).toEqual([id]);
  }
  expect(doc.transitions.filter((row) => row.to === 'cooling' || row.to === 'same')).toEqual([]);
});
