import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/admin/src');
const directory = join(root, 'pages/messages');

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
  );
}
function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}
function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}
/** Module names of the value imports and the identifiers of `sources`. */
function scan(sources: readonly ts.SourceFile[]): { imports: string[]; names: Set<string> } {
  const imports: string[] = [];
  const names = new Set<string>();
  for (const file of sources)
    visit(file, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        !node.importClause?.isTypeOnly &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (ts.isIdentifier(node)) names.add(node.text);
    });
  return { imports, names };
}

it('[AC-F1-06zv-SOURCE#1] 页面在 pages/messages 并由 App.tsx 登记，文案在 texts/messages.ts，动态码用现有 step-up，读写经 data provider、不直接 fetch', () => {
  expect(existsSync(join(root, 'texts/messages.ts')), 'texts/messages.ts').toBe(true);
  const pages = files(directory)
    .filter((path) => /\.tsx?$/.test(path) && !/\.(?:test|d)\.tsx?$/.test(path))
    .map(parse);
  expect(pages.length, 'source files under pages/messages').toBeGreaterThan(0);
  const { imports, names } = scan(pages);
  expect(imports.some((name) => /texts\/messages(?:\.ts)?$/.test(name))).toBe(true);
  const stepUp = /components\/step-up(?:\/|$)|\/useStepUp(?:\.tsx?)?$/;
  expect(imports.some((name) => stepUp.test(name))).toBe(true);
  expect(
    ['useDataProvider', 'useCustom', 'useCustomMutation', 'custom'].some((name) => names.has(name)),
  ).toBe(true);
  for (const banned of ['fetch', 'XMLHttpRequest', 'dangerouslySetInnerHTML'])
    expect(names.has(banned), banned).toBe(false);
  const app = scan([parse(join(root, 'App.tsx'))]);
  expect(app.imports.some((name) => /^\.\/pages\/messages(?:\/|$)/.test(name))).toBe(true);
});
