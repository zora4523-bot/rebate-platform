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

it('[AC-F1-07j-SOURCE#1] 定稿新文案集中于 users 字典，页面不硬编码颜色、ant 类名或注入 HTML', () => {
  const dictionary = source(join(root, 'texts/users.ts'));
  const copy = new Set<string>();
  visit(dictionary, (node) => {
    if (ts.isStringLiteralLike(node)) copy.add(node.text);
  });
  // Positive final-copy requirements keep this guard red on F1-07i, which already meets bans.
  for (const text of [
    'UID 或手机号',
    '已应用',
    '用户查询列表',
    '没有符合条件的用户',
    '重置条件',
    '列表加载失败',
    '网络错误或服务异常；已填条件保留，点【重试】按同样条件重新请求。',
  ])
    expect(copy.has(text), `texts/users.ts contains final copy: ${text}`).toBe(true);

  const violations: string[] = [];
  const imports: string[] = [];
  for (const path of files(join(root, 'pages/users'))) {
    if (/\.(test|d)\.tsx?$/.test(path)) continue;
    if (/\.tsx?$/.test(path)) {
      const file = source(path);
      visit(file, (node) => {
        const location = `${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
          imports.push(node.moduleSpecifier.text);
        if (ts.isIdentifier(node) && node.text === 'dangerouslySetInnerHTML')
          violations.push(`${location}: dangerouslySetInnerHTML`);
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
          if (node.text === 'dangerouslySetInnerHTML')
            violations.push(`${location}: HTML injection`);
          if (/[\u3400-\u9fff]/u.test(node.text))
            violations.push(`${location}: copy outside dictionary`);
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          // Also catch the common attempt to split the forbidden prefix: 'ant' + '-...'.
          if (ts.isStringLiteralLike(node.left) && node.left.text === 'ant')
            violations.push(`${location}: concatenated ant class`);
        }
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
  expect(imports.some((path) => /texts\/users\.ts$/.test(path))).toBe(true);
  expect(imports).toContain('antd');
  expect(violations).toEqual([]);
});
