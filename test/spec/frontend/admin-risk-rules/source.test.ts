import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/admin/src');
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

it('[AC-F1-10fa-SOURCE#1] 风控文案登记在 texts/risk.ts，页面引用它并复用现有二次验证组件', () => {
  expect(existsSync(join(root, 'texts/risk.ts')), 'risk text registry').toBe(true);
  const imports: string[] = [];
  const used = new Set<string>();
  const components = new Set<string>();
  for (const path of files(join(root, 'pages/risk')).filter(
    (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path),
  )) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    function visit(node: ts.Node): void {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        !node.importClause?.isTypeOnly
      ) {
        imports.push(node.moduleSpecifier.text);
        if (/components\/step-up(?:\/index\.ts)?$/.test(node.moduleSpecifier.text)) {
          const bindings = node.importClause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings))
            for (const binding of bindings.elements) {
              if ((binding.propertyName ?? binding.name).text === 'StepUpModal')
                components.add(binding.name.text);
            }
        }
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
        used.add(node.tagName.getText(source));
      if (
        ts.isCallExpression(node) &&
        /(?:^|\.)(?:createElement|jsx|jsxs)$/.test(node.expression.getText(source)) &&
        node.arguments[0]
      )
        used.add(node.arguments[0].getText(source));
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(imports.some((path) => /texts\/risk\.ts$/.test(path))).toBe(true);
  expect(
    [...components].some((name) => used.has(name)),
    'reuse StepUpModal',
  ).toBe(true);
});
