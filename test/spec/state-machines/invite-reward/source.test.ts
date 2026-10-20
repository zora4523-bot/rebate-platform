import ts from 'typescript';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { readRequired } from '../order/kit.ts';
import { EVENTS, ROWS, STATES, machine, publicExports, transitionOf } from './kit.ts';

it('[AC-B1-35a#1] YAML 的五个状态、三个事件和四行迁移等于独立预期', () => {
  const doc = machine();
  expect(doc.states).toEqual(STATES);
  expect(doc.events).toEqual(EVENTS);
  expect(Object.keys(doc).sort()).toEqual(
    ['name', 'field', 'states', 'events', 'transitions'].sort(),
  );
  expect(doc.transitions).toHaveLength(4);
  expect(doc.transitions.map((row) => row.id).sort()).toEqual(['R1', 'R2', 'R3', 'R4']);
  for (const row of doc.transitions) {
    expect(Object.keys(row).sort()).toEqual(
      ['id', 'from', 'event', 'to', 'guard', 'test_id'].sort(),
    );
    expect(row.guard).toEqual(expect.any(String));
    expect(row.guard.trim().length).toBeGreaterThan(0);
    expect(row.test_id).toBe(`SM-IRW-${row.id}`);
  }
  const actual = doc.transitions.map(({ id, from, event, to }) => ({
    id,
    from: [...from].sort(),
    event,
    to,
  }));
  expect(actual.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
    ROWS.map((row) => ({ ...row, from: [...row.from].sort() })),
  );
  expect(doc.transitions.flatMap((row) => row.from)).toHaveLength(6);
});

it('[AC-B1-35a#2] YAML 与契约枚举、0055 状态 CHECK 逐值一致', () => {
  const doc = machine();
  const parsed = parseYamlLite(readRequired('contracts/enums/identity.yaml'));
  expect(parsed).toMatchObject({
    enums: { invite_reward_status: { values: expect.any(Object) } },
  });
  const contract = parsed as {
    enums: { invite_reward_status: { values: Record<string, unknown> } };
  };
  const values = Object.keys(contract.enums.invite_reward_status.values);
  expect(values).toEqual(STATES);
  expect(doc.states).toEqual(values);

  const sql = readRequired('db/migrations/0055_invite-rewards.sql').replace(/--[^\n]*/g, '');
  const check =
    /CONSTRAINT\s+invite_rewards_status_check\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]+)\)\s*\)/i.exec(
      sql,
    );
  expect(check, '必须读取指定 CHECK，不能误用迁移注释或其他枚举').not.toBeNull();
  const sqlStates = [...check![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
  expect(sqlStates.sort()).toEqual([...STATES].sort());
  expect([...doc.states].sort()).toEqual(sqlStates);
});

it('[AC-B1-35a#3] 包入口导出 YAML 的完整状态、事件、迁移表和迁移函数', () => {
  const doc = machine();
  const exports = publicExports();
  expect(exports['INVITE_REWARD_STATES']).toEqual(doc.states);
  expect(exports['INVITE_REWARD_EVENTS']).toEqual(doc.events);
  expect(exports['INVITE_REWARD_TRANSITIONS']).toEqual(doc.transitions);
  expect(transitionOf(exports)).toEqual(expect.any(Function));
});

it('[AC-B1-35a#3] 包入口从生成物转出四个公共类型', () => {
  const ast = ts.createSourceFile(
    'index.ts',
    readRequired('packages/domain/src/index.ts'),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = ast.statements.flatMap((node) => {
    if (
      !ts.isExportDeclaration(node) ||
      !node.moduleSpecifier ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== './state-machines/invite-reward.gen.ts' ||
      !node.exportClause ||
      !ts.isNamedExports(node.exportClause)
    ) {
      return [];
    }
    return node.exportClause.elements
      .filter((element) => node.isTypeOnly || element.isTypeOnly)
      .map((element) => element.name.text);
  });
  expect(names.sort()).toEqual(
    [
      'InviteRewardState',
      'InviteRewardEvent',
      'InviteRewardTransitionRow',
      'InviteRewardTransitionResult',
    ].sort(),
  );
});

it('[AC-B1-35a#6] 三个终态没有出迁移，budget_exhausted 没有入迁移或备选目标', () => {
  const doc = machine();
  expect(doc.states).toEqual(STATES);
  for (const row of doc.transitions) {
    expect(row.to).not.toBe('budget_exhausted');
    expect(row).not.toHaveProperty('alternatives');
    for (const terminal of ['processed', 'voided', 'budget_exhausted']) {
      expect(row.from).not.toContain(terminal);
    }
    expect(row.from).not.toContain(null);
    expect(row.from).not.toContain('*');
  }
});
