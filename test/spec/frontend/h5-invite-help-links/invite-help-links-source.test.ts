import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Paths are resolved from this file's directory string; files are read only inside the test.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const pageDirectory = join(root, 'apps/h5/src/entries/app/pages/invite');
const textPath = join(root, 'apps/h5/src/texts/invite.ts');

/** Page sources (tests and declarations excluded) plus the page's text module. */
function sources(): { name: string; source: string }[] {
  const pages = readdirSync(pageDirectory, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.tsx?$/.test(name) && !/\.(?:test|d)\.tsx?$/.test(name))
    .map((name) => ({ name, source: readFileSync(join(pageDirectory, name), 'utf8') }));
  const texts = existsSync(textPath)
    ? [{ name: 'texts/invite.ts', source: readFileSync(textPath, 'utf8') }]
    : [];
  return [...pages, ...texts];
}

function walk(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => walk(child, inspect));
}

it('[AC-F1-05c-SOURCE#1] 邀请页源码与 texts/invite.ts 不再写死文章标识 invite-rules / invite-reward', () => {
  const found = sources();
  expect(found.length, '邀请页源码').toBeGreaterThan(0);
  const violations: string[] = [];
  for (const { name, source } of found) {
    const kind = ts.ScriptKind.TSX;
    const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, kind);
    walk(file, (node) => {
      if (
        (ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        /invite-rules|invite-reward/.test(node.text)
      )
        violations.push(`${name}: ${node.text}`);
    });
  }
  expect(violations).toEqual([]);
});
