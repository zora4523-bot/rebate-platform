import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import * as index from '../../../../apps/api/src/modules/payout/index.ts';
import * as port from '../../../../apps/api/src/modules/payout/ports/withdrawal-notification.ts';
import * as readEntry from '../../../../apps/api/src/modules/payout/read.ts';
import { INDEX_PATH, PORT_PATH, PRIVATE_KEYS, READ_PATH } from './fields.ts';

function parse(relative: string) {
  const text = readFileSync(new URL(relative, import.meta.url), 'utf8');
  return ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Named re-exports of `source` from `specifier`, split into value and type-only names. */
function reExports(source: ts.SourceFile, specifier: string) {
  const values: string[] = [];
  const types: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const from = statement.moduleSpecifier;
    if (!from || !ts.isStringLiteral(from) || from.text !== specifier) continue;
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) continue;
    for (const element of clause.elements) {
      (statement.isTypeOnly || element.isTypeOnly ? types : values).push(element.name.text);
    }
  }
  return { values: values.sort(), types: types.sort() };
}

function visit(node: ts.Node, each: (node: ts.Node) => void) {
  each(node);
  node.forEachChild((child) => visit(child, each));
}

it('[AC-B2-05l#7] 端口经 payout/index.ts 导出、不进 read.ts；read.ts 仍只导出 listWithdrawalsForUser', () => {
  const exported = reExports(parse(INDEX_PATH), './ports/withdrawal-notification.ts');
  expect(exported.values).toEqual(['createWithdrawalNotificationReader']);
  expect(exported.types).toEqual(['WithdrawalNotificationReader', 'WithdrawalNotificationView']);
  expect(index.createWithdrawalNotificationReader).toBe(port.createWithdrawalNotificationReader);

  const read = parse(READ_PATH);
  const names: string[] = [];
  for (const statement of read.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      expect(clause && ts.isNamedExports(clause)).toBe(true);
      for (const element of (clause as ts.NamedExports).elements) names.push(element.name.text);
    } else {
      // No local declarations, `export *` or default export in the restricted entry (BR-AI-02 ④).
      expect(ts.isImportDeclaration(statement)).toBe(true);
    }
  }
  expect(names).toEqual(['listWithdrawalsForUser']);
  expect(Object.keys(readEntry)).toEqual(['listWithdrawalsForUser']);
  expect(read.text).not.toContain('withdrawal-notification');

  // The exported factory is usable: it returns a reader with a read method.
  const reader = index.createWithdrawalNotificationReader();
  expect(typeof reader.read).toBe('function');
});

it('[AC-B2-05l#8] 端口源码只读：不写表、不解密、不记日志、显式列清单且不选个人信息列', () => {
  const source = parse(PORT_PATH);
  const forbidden = new Set([
    'insertInto',
    'updateTable',
    'deleteFrom',
    'mergeInto',
    'replaceInto',
    'selectAll',
    'decrypt',
    'console',
    'logger',
    'ROOT_LOGGER',
  ]);
  const used: string[] = [];
  const literals: string[] = [];
  const tables: string[] = [];
  const specifiers: string[] = [];
  visit(source, (node) => {
    if (ts.isIdentifier(node) && forbidden.has(node.text)) used.push(node.text);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.push(node.text);
    }
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      literals.push(node.text);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'selectFrom'
    ) {
      for (const arg of node.arguments) {
        if (ts.isStringLiteral(arg)) tables.push(arg.text);
      }
    }
  });
  expect(used).toEqual([]);
  for (const key of PRIVATE_KEYS) {
    expect(literals.some((text) => text.split(/[\s.,]+/).includes(key))).toBe(false);
  }
  expect(
    literals.filter((text) => /\b(insert|update|delete|merge|truncate)\b/i.test(text)),
  ).toEqual([]);
  expect(specifiers.filter((s) => /logging|pino|crypto|identity/.test(s))).toEqual([]);
  expect(tables.every((table) => table === 'withdrawals' || table === 'app.withdrawals')).toBe(
    true,
  );

  // A read port that exists only as source text is not done: the factory must build a reader.
  const reader = port.createWithdrawalNotificationReader();
  expect(typeof reader.read).toBe('function');
});
