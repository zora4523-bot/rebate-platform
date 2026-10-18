import ts from 'typescript';
import { expect } from 'vitest';
import { read } from './kit.ts';

// 只解析 AST，绝不 import / eval 被测生成物或一致性脚本。
export function source(path: string): ts.SourceFile {
  return ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
export function initializer(path: string, name: string): ts.Expression {
  const declarations = source(path)
    .statements.filter(ts.isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations])
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === name);
  expect(declarations, `必须声明 ${name}`).toHaveLength(1);
  let value = declarations[0]!.initializer;
  expect(value).toBeDefined();
  while (
    value &&
    (ts.isAsExpression(value) ||
      ts.isSatisfiesExpression(value) ||
      ts.isParenthesizedExpression(value))
  )
    value = value.expression;
  return value!;
}
export function generated(path: string, name: string): unknown {
  return JSON.parse(initializer(path, name).getText());
}
export function bindings(): Record<string, string> {
  const value = initializer('packages/contracts-ts/scripts/conformance.ts', 'ENUM_BINDINGS');
  expect(ts.isObjectLiteralExpression(value)).toBe(true);
  const result: Record<string, string> = {};
  if (ts.isObjectLiteralExpression(value)) {
    for (const member of value.properties) {
      expect(ts.isPropertyAssignment(member)).toBe(true);
      if (!ts.isPropertyAssignment(member)) continue;
      expect(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)).toBe(true);
      expect(ts.isStringLiteral(member.initializer)).toBe(true);
      if (
        (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
        ts.isStringLiteral(member.initializer)
      ) {
        result[member.name.text] = member.initializer.text;
      }
    }
  }
  return result;
}
export function namedInterface(file: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  const matches = file.statements.filter(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === name,
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}
export function property(node: ts.Node, name: string): ts.PropertySignature {
  const matches: ts.PropertySignature[] = [];
  function visit(child: ts.Node): void {
    if (
      ts.isPropertySignature(child) &&
      (ts.isIdentifier(child.name) ||
        ts.isStringLiteral(child.name) ||
        ts.isNumericLiteral(child.name)) &&
      child.name.text === name
    )
      matches.push(child);
    ts.forEachChild(child, visit);
  }
  ts.forEachChild(node, visit);
  expect(matches, `生成类型缺少或重复 ${name}`).toHaveLength(1);
  return matches[0]!;
}
