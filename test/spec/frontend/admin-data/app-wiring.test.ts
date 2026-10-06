import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('[AC-F1-06g-APP#1] App 的实际 Refine 节点同时接入 data provider 和 accessControlProvider', () => {
  const source = readFileSync(
    new URL('../../../../apps/admin/src/App.tsx', import.meta.url),
    'utf8',
  );
  const file = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const refineBindings = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@refinedev/core'
    )
      continue;
    const named = statement.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        if ((element.propertyName ?? element.name).text === 'Refine')
          refineBindings.add(element.name.text);
      }
    }
  }
  const roots: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      refineBindings.has(node.tagName.getText(file))
    )
      roots.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(roots.length).toBeGreaterThan(0);
  for (const root of roots) {
    for (const name of ['dataProvider', 'accessControlProvider']) {
      const attributes = root.attributes.properties;
      const index = attributes.findLastIndex(
        (attr) => ts.isJsxAttribute(attr) && attr.name.getText(file) === name,
      );
      expect(index, name).toBeGreaterThanOrEqual(0);
      const attribute = attributes[index];
      expect(attribute && ts.isJsxAttribute(attribute), name).toBe(true);
      if (!attribute || !ts.isJsxAttribute(attribute)) continue;
      const initializer = attribute.initializer;
      expect(
        initializer && ts.isJsxExpression(initializer) && initializer.expression !== undefined,
        name,
      ).toBe(true);
      if (initializer && ts.isJsxExpression(initializer)) {
        expect(initializer.expression?.getText(file), name).not.toMatch(/^(undefined|null|false)$/);
      }
      expect(attributes.slice(index + 1).some(ts.isJsxSpreadAttribute), name).toBe(false);
    }
  }
});
