import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { filterSegment } from '../../../../apps/api/src/modules/agent/guard/index.ts';

it('[AC-B3-06a#24] 过滤器可独立调用，源码不依赖评测器、平台 IO 或文件系统', () => {
  // A functioning pure entry and its import boundary are one acceptance condition;
  // calling it first keeps this test red during the NotImplemented phase as required.
  expect(filterSegment('独立说明')).toEqual({ text: '独立说明', hits: [] });
  const root = fileURLToPath(
    new URL('../../../../apps/api/src/modules/agent/guard/', import.meta.url),
  );
  const violations: string[] = [];
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[cm]?tsx?$/u.test(entry.name))
    .map((entry) => resolve(entry.parentPath, entry.name));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const check = (specifier: string): void => {
      const target = specifier.startsWith('.') ? resolve(dirname(file), specifier) : specifier;
      if (
        /(?:packages\/evals|@couli\/evals|platform\/(?:clock|redis|db)(?:\/|\.|$)|^(?:node:)?fs(?:\/|$))/u.test(
          target,
        )
      ) {
        violations.push(`${file}: ${specifier}`);
      }
    };
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      )
        check(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) check(argument.text);
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      )
        check(node.argument.literal.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
