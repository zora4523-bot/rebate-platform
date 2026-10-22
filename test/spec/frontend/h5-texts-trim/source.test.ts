import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { ROOT } from './trim-kit.ts';

it('[AC-F1-01t-SOURCE#1] texts 模块不再顶层无条件 eager glob 整份契约字典', () => {
  const file = new URL('apps/h5/src/shared/texts.ts', ROOT);
  const source = ts.createSourceFile(
    file.pathname,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const forbidden: string[] = [];
  function visit(node: ts.Node): void {
    // Only the old unconditional top-level eager glob is forbidden here. Direct imports,
    // including plugin-handled query suffixes, are valid: BUNDLE/GROWTH prove actual pruning.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === 'import.meta' &&
      /^(?:glob|globEager)$/.test(node.expression.name.text) &&
      node.arguments.some(
        (argument) =>
          ts.isStringLiteralLike(argument) &&
          /(?:^|\/)contracts\/texts\.default\.json$/.test(argument.text),
      ) &&
      (node.expression.name.text === 'globEager' ||
        node.arguments.some(
          (argument) =>
            ts.isObjectLiteralExpression(argument) &&
            argument.properties.some(
              (property) =>
                ts.isPropertyAssignment(property) &&
                property.name.getText(source).replace(/['"]/g, '') === 'eager' &&
                property.initializer.kind === ts.SyntaxKind.TrueKeyword,
            ),
        )) &&
      ts.isVariableDeclaration(node.parent) &&
      ts.isVariableDeclarationList(node.parent.parent) &&
      ts.isVariableStatement(node.parent.parent.parent) &&
      ts.isSourceFile(node.parent.parent.parent.parent)
    ) {
      forbidden.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(forbidden).toEqual([]);
});
