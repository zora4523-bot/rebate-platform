// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const moduleUrl = import.meta.url;
const root = resolve(fileURLToPath(new URL('.', moduleUrl)), '../../../../apps/admin/src');
const COLORS = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i;
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}
function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}
function source(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}
function namedColor(value: string): boolean {
  if (
    !/^[a-z]+$/i.test(value) ||
    /^(inherit|initial|unset|revert|currentcolor|transparent)$/i.test(value)
  )
    return false;
  const probe = document.createElement('span').style;
  probe.color = value;
  return probe.color !== '';
}

it('[AC-F1-07g-SOURCE#1] 关系区文案集中 users.ts，使用 antd 与现有 step-up、不硬编码色值类名或直接 fetch', () => {
  const dictionary = source(join(root, 'texts/users.ts'));
  const copy = new Set<string>();
  visit(dictionary, (node) => {
    if (ts.isStringLiteralLike(node)) copy.add(node.text);
  });
  for (const text of ['上级与直推', '查看直推名单', '调等级', '改上级'])
    expect(copy.has(text), `relations copy in texts/users.ts: ${text}`).toBe(true);

  const violations: string[] = [];
  const imports: string[] = [];
  // Existing UserDetailView imports cannot satisfy the new relations components' requirements.
  const relationFiles = files(join(root, 'pages/users')).filter((path) =>
    path.startsWith(join(root, 'pages/users/relations')),
  );
  expect(relationFiles.length, 'relations source files exist').toBeGreaterThan(0);
  for (const path of relationFiles) {
    if (/\.(test|d)\.tsx?$/.test(path)) continue;
    if (/\.tsx?$/.test(path)) {
      const file = source(path);
      visit(file, (node) => {
        const location = `${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
          imports.push(node.moduleSpecifier.text);
        if (
          ts.isIdentifier(node) &&
          ['fetch', 'XMLHttpRequest', 'dangerouslySetInnerHTML'].includes(node.text)
        )
          violations.push(`${location}: bypass provider / HTML injection`);
        if (ts.isJsxText(node) && /[\u3400-\u9fff]/u.test(node.text))
          violations.push(`${location}: JSX copy outside dictionary`);
        if (
          ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)
        ) {
          if (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) return;
          if (COLORS.test(node.text) || namedColor(node.text))
            violations.push(`${location}: literal color ${node.text}`);
          if (/\bant-/.test(node.text)) violations.push(`${location}: handwritten ant class`);
          if (['fetch', 'XMLHttpRequest'].includes(node.text))
            violations.push(`${location}: indirect network call`);
          if (/[\u3400-\u9fff]/u.test(node.text))
            violations.push(`${location}: copy outside dictionary`);
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
          ts.isStringLiteralLike(node.left) &&
          node.left.text === 'ant'
        )
          violations.push(`${location}: concatenated ant class`);
      });
    } else if (path.endsWith('.css')) {
      const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/\bant-/.test(css) || COLORS.test(css))
        violations.push(`${path}: literal color / ant selector`);
      for (const declaration of css.matchAll(/(?:^|[;{])\s*[\w-]+\s*:\s*([^;{}]+)/g))
        for (const word of declaration[1]!.replace(/--[\w-]+/g, '').matchAll(/\b[a-z]+\b/gi))
          if (namedColor(word[0])) violations.push(`${path}: named color ${word[0]}`);
    }
  }
  expect(imports).toContain('antd');
  expect(imports.some((path) => /texts\/users\.ts$/.test(path))).toBe(true);
  expect(imports.some((path) => /components\/step-up\//.test(path))).toBe(true);
  expect(violations).toEqual([]);
});
