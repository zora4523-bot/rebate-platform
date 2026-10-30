// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { REF, SOURCE_NAME, TYPE_NAME, createServer, diffs } from './fixtures.ts';
import { COLUMN, FLOW_TIMEOUT, cellText, mount, openDiffs, squash } from './helpers.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/admin/src');
const directory = join(root, 'pages/recon');
const textsFile = join(root, 'texts/recon.ts');

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
/** Module names of the value imports, the identifiers and the string literals of `sources`. */
function scan(sources: readonly ts.SourceFile[]) {
  const imports: string[] = [];
  const names = new Set<string>();
  const strings: string[] = [];
  for (const file of sources)
    visit(file, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        !node.importClause?.isTypeOnly &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (ts.isIdentifier(node)) names.add(node.text);
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node))
        strings.push(node.text);
      if (ts.isTemplateTail(node)) strings.push(node.text);
    });
  return { imports, names, strings };
}

it('[AC-F1-08e-SOURCE#1] 页面在 pages/recon 并由 App.tsx 登记，文案在 texts/recon.ts，读写经 data provider、不直接 fetch、不用动态码', () => {
  expect(existsSync(textsFile), 'texts/recon.ts').toBe(true);
  const pages = files(directory)
    .filter((path) => /\.tsx?$/.test(path) && !/\.(?:test|d)\.tsx?$/.test(path))
    .map(parse);
  expect(pages.length, 'source files under pages/recon').toBeGreaterThan(0);
  const { imports, names } = scan(pages);
  expect(imports.some((name) => /texts\/recon(?:\.ts)?$/.test(name))).toBe(true);
  expect(
    ['useDataProvider', 'useCustom', 'useCustomMutation', 'custom', 'useList', 'useOne'].some(
      (name) => names.has(name),
    ),
  ).toBe(true);
  for (const banned of ['fetch', 'XMLHttpRequest', 'dangerouslySetInnerHTML'])
    expect(names.has(banned), banned).toBe(false);
  const stepUp = /components\/step-up(?:\/|$)|\/useStepUp(?:\.tsx?)?$/;
  expect(
    imports.filter((name) => stepUp.test(name)),
    'no step-up on this page',
  ).toEqual([]);
  const app = scan([parse(join(root, 'App.tsx'))]);
  expect(app.imports.some((name) => /^\.\/pages\/recon(?:\/|$)/.test(name))).toBe(true);
});

it(
  '[AC-F1-08e-SOURCE#2] 类型 / 状态中文名取后台字典（admin_dict.recon_diff_type / recon_diff_status），不在页面或 texts/recon.ts 里另写类型名；来源列显示字典值（R1 联盟对账 / R2 通道对账 / R3 内部日终）',
  async () => {
    expect(existsSync(textsFile), 'texts/recon.ts').toBe(true);
    const sources = [
      ...files(directory).filter(
        (path) => /\.tsx?$/.test(path) && !/\.(?:test|d)\.tsx?$/.test(path),
      ),
      textsFile,
    ].map(parse);
    const { strings } = scan(sources);
    const all = strings.join('\n');
    for (const key of ['recon_diff_type', 'recon_diff_status'])
      expect(all.includes(key), `dictionary key ${key}`).toBe(true);
    for (const name of Object.values(TYPE_NAME))
      expect(all.includes(name), `type name ${name} is read from the dictionary`).toBe(false);
    // The source names: however the dictionary key is built, the column shows its values.
    const server = createServer();
    await mount(server);
    await openDiffs(server, REF.ledger);
    for (const item of diffs())
      expect(squash(cellText(item.ref_id, COLUMN.source)), `${item.ref_id} source`).toContain(
        SOURCE_NAME[item.source],
      );
  },
  FLOW_TIMEOUT,
);
