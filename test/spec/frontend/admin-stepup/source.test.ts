// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { COPY } from './fixtures.ts';

const moduleUrl = import.meta.url;
const sourceRoot = new URL('../../../../apps/admin/src/', moduleUrl);

function files(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.name, directory);
    return entry.isDirectory()
      ? files(new URL(`${entry.name}/`, directory))
      : /\.(?:tsx?|css)$/.test(entry.name) && !/\.(?:test|d)\.tsx?$/.test(entry.name)
        ? [url]
        : [];
  });
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}

function dictionary(): string {
  const url = new URL('texts/step-up.ts', sourceRoot);
  // A missing dictionary is an assertion failure during the red phase, never ENOENT.
  expect(existsSync(url), 'step-up copy must live in texts/step-up.ts').toBe(true);
  return readFileSync(url, 'utf8');
}

it('[AC-F1-06f-SOURCE#1] 中文文案集中到词典，组件包括 JSX 和模板片段无中文字面量', () => {
  const source = dictionary();
  const dictionaryAst = ts.createSourceFile('step-up.ts', source, ts.ScriptTarget.Latest, true);
  const literals: string[] = [];
  visit(dictionaryAst, (node) => {
    if (ts.isStringLiteralLike(node)) literals.push(node.text);
  });
  for (const text of [COPY.missingPhone, COPY.incorrect, COPY.expired, COPY.frequent, COPY.generic])
    expect(literals).toContain(text);
  const violations: string[] = [];
  for (const path of ['components/otp-input/', 'components/step-up/']) {
    for (const url of files(new URL(path, sourceRoot))) {
      if (url.pathname.endsWith('.css')) continue;
      const ast = ts.createSourceFile(
        url.pathname,
        readFileSync(url, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      visit(ast, (node) => {
        if (
          (ts.isStringLiteralLike(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node) ||
            ts.isJsxText(node)) &&
          /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(node.text)
        )
          violations.push(
            `${url.pathname}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`,
          );
      });
    }
  }
  expect(violations).toEqual([]);
});

it('[AC-F1-06f-SOURCE#2] 组件和局部样式从令牌取色，无字面色值', () => {
  dictionary();
  const violations: string[] = [];
  const probe = document.createElement('span');
  function check(value: string, path: string): void {
    const stripped = value.replace(/var\(--[\w-]+\)/g, '').trim();
    if (/^(?:currentcolor|transparent|inherit|initial|unset|revert|revert-layer)$/i.test(stripped))
      return;
    probe.style.color = '';
    probe.style.color = stripped;
    if (
      probe.style.color !== '' ||
      /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i.test(stripped)
    )
      violations.push(`${path}: ${value}`);
  }
  for (const path of ['components/otp-input/', 'components/step-up/']) {
    for (const url of files(new URL(path, sourceRoot))) {
      const source = readFileSync(url, 'utf8');
      if (url.pathname.endsWith('.css')) {
        for (const declaration of source
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .matchAll(/[\w-]+\s*:\s*([^;{}]+)/g)) {
          check(declaration[1]!, url.pathname);
          for (const word of declaration[1]!.replace(/var\([^)]*\)/g, '').matchAll(/\b[a-z]+\b/gi))
            check(word[0], url.pathname);
        }
      } else {
        const ast = ts.createSourceFile(
          url.pathname,
          source,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX,
        );
        visit(ast, (node) => {
          if (
            ts.isStringLiteralLike(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node)
          )
            check(node.text, url.pathname);
        });
      }
    }
  }
  expect(violations).toEqual([]);
});
