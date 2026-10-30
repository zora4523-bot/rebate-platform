// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { dictNames } from './fixtures.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/admin/src');
const directory = join(root, 'pages/pay-orders');
const textsFile = join(root, 'texts/pay-orders.ts');

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
function pageSources(): ts.SourceFile[] {
  return files(directory)
    .filter((path) => /\.tsx?$/.test(path) && !/\.(?:test|d)\.tsx?$/.test(path))
    .map(parse);
}

it('[AC-F1-13a-SOURCE#1] 页面在 pages/pay-orders 并由 App.tsx 登记，文案在 texts/pay-orders.ts，读经 data provider、不直接 fetch、不用动态码', () => {
  expect(existsSync(textsFile), 'texts/pay-orders.ts').toBe(true);
  const pages = pageSources();
  expect(pages.length, 'source files under pages/pay-orders').toBeGreaterThan(0);
  const { imports, names } = scan(pages);
  expect(imports.some((name) => /texts\/pay-orders(?:\.ts)?$/.test(name))).toBe(true);
  expect(
    ['useDataProvider', 'useCustom', 'useList', 'useOne', 'useTable', 'custom'].some((name) =>
      names.has(name),
    ),
  ).toBe(true);
  for (const banned of ['fetch', 'XMLHttpRequest', 'dangerouslySetInnerHTML'])
    expect(names.has(banned), banned).toBe(false);
  const stepUp = /components\/step-up(?:\/|$)|\/useStepUp(?:\.tsx?)?$/;
  expect(
    imports.filter((name) => stepUp.test(name)),
    'no step-up on this read-only page',
  ).toEqual([]);
  const app = scan([parse(join(root, 'App.tsx'))]);
  expect(app.imports.some((name) => /^\.\/pages\/pay-orders(?:\/|$)/.test(name))).toBe(true);
});

it('[AC-F1-13a-SOURCE#2] 支付单状态、渠道与差错类型的中文名取后台字典（admin_dict.pay_order_status / pay_channel / recon_diff_type），不在页面或 texts/pay-orders.ts 里另写', () => {
  expect(existsSync(textsFile), 'texts/pay-orders.ts').toBe(true);
  const { strings } = scan([...pageSources(), parse(textsFile)]);
  const all = strings.join('\n');
  for (const key of ['pay_order_status', 'pay_channel', 'recon_diff_type'])
    expect(all.includes(key), `dictionary key ${key}`).toBe(true);
  // The names the dictionary has (read when the test runs) are not written again here.
  const names = [
    ...dictNames('payStatus', 'PENDING'),
    ...dictNames('payStatus', 'PAID'),
    ...dictNames('channel', 'alipay'),
    ...dictNames('channel', 'wechat_pay'),
    ...dictNames('diffType', 'pay_mismatch'),
  ];
  expect(names.length, 'the dictionary has these rows').toBeGreaterThan(0);
  for (const name of names)
    expect(all.includes(name), `name ${name} is read from the dictionary`).toBe(false);
});
