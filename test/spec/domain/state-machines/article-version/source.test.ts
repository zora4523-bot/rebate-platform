import ts from 'typescript';
import { expect, it } from 'vitest';
import { readRequired } from '../../../state-machines/order/kit.ts';
import { EVENTS, LEGAL, machine, publicExports, STATES } from './kit.ts';

it('[AC-F1-02u#1] YAML 只含三个状态、三个事件及 A1/A2/A3 三行迁移', () => {
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
    expect(row.test_id).toMatch(/^AC-F1-02u#[1-9]\d*$/);
    expect(row.guard).toEqual(expect.any(String));
    expect(row.guard.trim().length).toBeGreaterThan(0);
  }
  expect(doc).not.toHaveProperty('stages');
  expect(doc).not.toHaveProperty('event_states');
});

it('[AC-F1-02u#2] YAML 和公开状态集合与 0049 的 articles_status_check 一致', () => {
  const doc = machine();
  const sql = readRequired('db/migrations/0049_dict-items-articles-status.sql');
  const check =
    /CONSTRAINT\s+articles_status_check\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]+)\)\s*\)/i.exec(sql);
  expect(check).not.toBeNull();
  const values = [...(check?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
  expect(values.sort()).toEqual([...STATES].sort());
  expect([...doc.states].sort()).toEqual(values);
  expect(publicExports()['ARTICLE_VERSION_STATES']).toEqual(doc.states);
});

it('[AC-F1-02u#3] 包入口导出 YAML 的状态、事件和完整迁移表', () => {
  const doc = machine();
  const exports = publicExports();
  expect(exports['ARTICLE_VERSION_STATES']).toEqual(doc.states);
  expect(exports['ARTICLE_VERSION_EVENTS']).toEqual(doc.events);
  expect(exports['ARTICLE_VERSION_TRANSITIONS']).toEqual(doc.transitions);
});

it('[AC-F1-02u#13] 包入口从生成物公开四个类型，供调用方使用', () => {
  const ast = ts.createSourceFile(
    'index.ts',
    readRequired('packages/domain/src/index.ts'),
    ts.ScriptTarget.Latest,
    true,
  );
  const types = ast.statements.flatMap((node) => {
    if (
      !ts.isExportDeclaration(node) ||
      !node.moduleSpecifier ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== './state-machines/article-version.gen.ts' ||
      !node.exportClause ||
      !ts.isNamedExports(node.exportClause)
    ) {
      return [];
    }
    return node.exportClause.elements
      .filter((item) => node.isTypeOnly || item.isTypeOnly)
      .map((item) => item.name.text);
  });
  expect(types.sort()).toEqual(
    [
      'ArticleVersionState',
      'ArticleVersionEvent',
      'ArticleVersionTransitionResult',
      'ArticleVersionTransitionRow',
    ].sort(),
  );
});
