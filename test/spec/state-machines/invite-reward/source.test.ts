import ts from 'typescript';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { readRequired } from '../order/kit.ts';
import { EVENTS, GENERATED, ROWS, STATES, machine, publicExports, transitionOf } from './kit.ts';

it('[AC-B1-35a#1] YAML 的五个状态、四个事件和五行迁移等于独立预期', () => {
  const doc = machine();
  expect(doc.states).toEqual(STATES);
  expect(doc.events).toEqual(EVENTS);
  expect(Object.keys(doc).sort()).toEqual(
    ['name', 'field', 'states', 'events', 'transitions'].sort(),
  );
  expect(doc.transitions).toHaveLength(5);
  expect(doc.transitions.map((row) => row.id).sort()).toEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
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
  expect(doc.transitions.flatMap((row) => row.from)).toHaveLength(7);
});

it('[AC-B1-35a#2] YAML 与契约枚举、当前 schema 的状态 CHECK 逐值一致', () => {
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

  // 0055 是不可变的历史迁移；0057 / 0058 重建后的约束以 schema 快照为准。
  const sql = readRequired('db/schema.sql').replace(/--[^\n]*/g, '');
  const table = /CREATE TABLE app\.invite_rewards\s*\(([\s\S]*?)\n\);/i.exec(sql);
  expect(table, '只读取 app.invite_rewards 表定义').not.toBeNull();
  const check =
    /CONSTRAINT\s+invite_rewards_status_check\s+CHECK\s*\(\(status\s*=\s*ANY\s*\(ARRAY\[([^\]]+)\]\)\)\)/i.exec(
      table![1]!,
    );
  expect(check, '必须读取指定 CHECK，不能误用注释或其他枚举').not.toBeNull();
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

it('[AC-B1-35a#3] 包入口转出四个公共类型，状态和事件联合类型含 expired / EXPIRE', () => {
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
  const generated = ts.createSourceFile(
    'invite-reward.gen.ts',
    readRequired(GENERATED),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const [name, expected] of [
    ['InviteRewardState', STATES],
    ['InviteRewardEvent', EVENTS],
  ] as const) {
    const alias = generated.statements.find(
      (node): node is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(node) && node.name.text === name,
    );
    expect(alias, `缺少 ${name} 类型声明`).toBeDefined();
    const union = alias!.type;
    expect(ts.isUnionTypeNode(union)).toBe(true);
    const members = (union as ts.UnionTypeNode).types.map((node) => {
      expect(ts.isLiteralTypeNode(node)).toBe(true);
      const literal = (node as ts.LiteralTypeNode).literal;
      expect(ts.isStringLiteral(literal)).toBe(true);
      return (literal as ts.StringLiteral).text;
    });
    expect(members).toEqual(expected);
  }
});

it('[AC-B1-35a#6] 三个终态没有出迁移，只有 qualified 可通过 EXPIRE 到 expired', () => {
  const doc = machine();
  expect(doc.states).toEqual(STATES);
  expect(
    doc.transitions
      .filter((row) => row.to === 'expired' || row.event === 'EXPIRE')
      .map(({ id, from, event, to }) => ({ id, from, event, to })),
  ).toEqual([{ id: 'R5', from: ['qualified'], event: 'EXPIRE', to: 'expired' }]);
  for (const row of doc.transitions) {
    expect(row).not.toHaveProperty('alternatives');
    for (const terminal of ['processed', 'voided', 'expired']) {
      expect(row.from).not.toContain(terminal);
    }
    expect(row.from).not.toContain(null);
    expect(row.from).not.toContain('*');
  }
});
