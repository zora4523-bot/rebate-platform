// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const moduleUrl = import.meta.url;
const root = fileURLToPath(new URL('../../../../', moduleUrl));

function sources(page: string) {
  const directory = `apps/h5/src/entries/app/pages/${page}`;
  return readdirSync(join(root, directory), { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.(?:tsx?|css)$/.test(name) && !/\.(?:test|d)\.tsx?$/.test(name))
    .map((name) => ({
      path: join(directory, name),
      source: readFileSync(join(root, directory, name), 'utf8'),
    }));
}

function walk(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => walk(child, inspect));
}

for (const [index, page] of ['notices', 'agreements'].entries()) {
  it(`[AC-F1-03c-SOURCE#${index * 2 + 1}] ${page} 使用 useApi、react-query 与 ArticleBody，不绕过客户端或新增正文渲染库`, () => {
    const violations: string[] = [];
    const used = new Set<string>();
    for (const { path, source } of sources(page)) {
      if (path.endsWith('.css')) continue;
      const tree = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const imports = new Map<string, string>();
      walk(tree, (node) => {
        const module =
          ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
            ? node.moduleSpecifier
            : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
              ? node.arguments[0]
              : undefined;
        if (module && ts.isStringLiteralLike(module)) {
          const specifier = module.text;
          if (
            /^(?:react-router|react-router-dom)(?:\/|$)/.test(specifier) &&
            !path.endsWith('/notices/router.ts')
          )
            violations.push(`${path}: direct router import`);
          if (
            /@tiptap|prosemirror|marked|markdown-it|html-react-parser|react-markdown|rehype|sanitize-html|dompurify|render-to-string/.test(
              specifier,
            )
          )
            violations.push(`${path}: renderer import ${specifier}`);
          if (ts.isImportDeclaration(node)) {
            const bindings = node.importClause?.namedBindings;
            if (bindings && ts.isNamedImports(bindings)) {
              for (const binding of bindings.elements) {
                const original = (binding.propertyName ?? binding.name).text;
                if (
                  (/shared\/api\/app-api\.ts$/.test(specifier) && original === 'useApi') ||
                  (/components\/article-body\/index\.ts$/.test(specifier) &&
                    original === 'ArticleBody') ||
                  (/shared\/env\.ts$/.test(specifier) && original === 'mediaOrigins') ||
                  (specifier === '@tanstack/react-query' &&
                    /^use(?:Infinite)?Query$/.test(original))
                )
                  imports.set(binding.name.text, original);
              }
            }
          }
        }
        if (
          (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
          /^(?:fetch|XMLHttpRequest|__REBATE_BRIDGE__|dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML)$/.test(
            node.text,
          )
        )
          violations.push(`${path}: forbidden API ${node.text}`);
      });
      walk(tree, (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const name = imports.get(node.expression.text);
          if (name) used.add(name);
          // createElement(ArticleBody, ...) as well as JSX is supported.
          for (const argument of node.arguments) {
            if (ts.isIdentifier(argument) && imports.get(argument.text) === 'ArticleBody')
              used.add('ArticleBody');
          }
        }
        if (
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          ts.isIdentifier(node.tagName) &&
          imports.get(node.tagName.text) === 'ArticleBody'
        )
          used.add('ArticleBody');
      });
    }
    // Positive use checks keep these tests red on a skeleton; prohibitions alone would pass.
    expect([...used]).toEqual(expect.arrayContaining(['useApi', 'ArticleBody', 'mediaOrigins']));
    expect(used.has('useQuery') || used.has('useInfiniteQuery')).toBe(true);
    expect(violations).toEqual([]);
  });

  it(`[AC-F1-03c-SOURCE#${index * 2 + 2}] ${page} 中文文案来自专用 texts 文件，页面颜色使用令牌`, () => {
    const dictionary = join(root, `apps/h5/src/texts/${page}.ts`);
    expect(existsSync(dictionary), '实现阶段添加专用文案字典').toBe(true);
    expect(readFileSync(dictionary, 'utf8')).toMatch(/[\u4e00-\u9fff]/u);
    const violations: string[] = [];
    let usesDictionary = false;
    function check(value: string, path: string) {
      if (/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(value))
        violations.push(`${path}: Chinese literal`);
      const clean = value.replace(/var\(--[\w-]+\)/g, '').trim();
      if (/^(?:transparent|currentcolor|inherit|initial|unset|none)$/i.test(clean)) return;
      const probe = document.createElement('span');
      probe.style.color = clean;
      if (
        probe.style.color ||
        /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i.test(clean) ||
        /\b(?:bg|text|border|fill|stroke)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+)\b/.test(
          clean,
        )
      )
        violations.push(`${path}: literal color ${value}`);
    }
    for (const { path, source } of sources(page)) {
      if (path.endsWith('.css')) {
        for (const match of source
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .matchAll(/[\w-]+\s*:\s*([^;{}]+)/g))
          check(match[1]!, path);
        continue;
      }
      const tree = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      walk(tree, (node) => {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteralLike(node.moduleSpecifier) &&
          node.moduleSpecifier.text.endsWith(`/texts/${page}.ts`)
        )
          usesDictionary = true;
        if (
          ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node) ||
          ts.isJsxText(node)
        )
          check(node.text, path);
      });
    }
    expect(usesDictionary).toBe(true);
    expect(violations).toEqual([]);
  });
}
