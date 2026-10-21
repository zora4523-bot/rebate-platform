// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const moduleUrl = import.meta.url;
const root = resolve(fileURLToPath(new URL('.', moduleUrl)), '../../../../apps/admin/src');
const directory = join(root, 'pages/orders');
const COLOR = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i;
function files(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
  );
}
function sources(): ts.SourceFile[] {
  return files(directory)
    .filter((path) => /\.tsx?$/.test(path) && !/\.(test|d)\.tsx?$/.test(path))
    .map((path) =>
      ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      ),
    );
}
function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}
function namedColors(value: string): string[] {
  const probe = document.createElement('span').style;
  const found: string[] = [];
  for (const token of value.replace(/--[\w-]+/g, '').matchAll(/\b[a-z]+\b/gi)) {
    if (/^(inherit|initial|unset|revert|currentcolor|transparent)$/i.test(token[0])) continue;
    probe.color = '';
    probe.color = token[0];
    if (probe.color !== '') found.push(token[0]);
  }
  return found;
}

function statusNames(): Map<string, string> {
  const contract = JSON.parse(
    readFileSync(resolve(root, '../../../contracts/texts.admin.default.json'), 'utf8'),
  ) as { texts: Record<string, string> };
  // AdmOrders / AdmOrderDetail: only the status codes exercised by these fixtures.
  const fallback: Record<string, string> = {
    'admin_dict.platform_status.PAID': '已付款',
    'admin_dict.platform_status.RECEIVED': '已收货',
    'admin_dict.platform_status.SETTLED': '联盟已结算',
    'admin_dict.rebate_status.UNATTRIBUTED': '未归因',
    'admin_dict.rebate_status.ESTIMATED': '预估',
    'admin_dict.rebate_status.WAITING': '等待结算',
    'admin_dict.rebate_status.CREDITED': '已结算入账',
  };
  const names = new Map(Object.entries(fallback));
  for (const [key, value] of Object.entries(contract.texts))
    if (/^admin_dict\.(platform_status|rebate_status)\./.test(key)) names.set(key, value);
  return names;
}

function hardcodedStatuses(file: ts.SourceFile, registry: string): string[] {
  const violations: string[] = [];
  const names = statusNames();
  visit(file, (node) => {
    if (
      !ts.isStringLiteralLike(node) &&
      !ts.isTemplateHead(node) &&
      !ts.isTemplateMiddle(node) &&
      !ts.isTemplateTail(node) &&
      !ts.isJsxText(node)
    )
      return;
    for (const [key, name] of names) {
      // Match a status label, including "中文 CODE", without banning field captions
      // such as "预估佣金" merely because they contain a shorter status name.
      if (!node.text.split(/[^\u3400-\u9fff]+/u).includes(name)) continue;
      let statusContext = false;
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        if (
          (ts.isPropertyAssignment(parent) ||
            ts.isVariableDeclaration(parent) ||
            ts.isFunctionDeclaration(parent) ||
            ts.isMethodDeclaration(parent)) &&
          parent.name &&
          /status|UNATTRIBUTED/i.test(parent.name.getText(file))
        )
          statusContext = true;
      }
      // The required null-user caption shares the board's UNATTRIBUTED spelling.
      // Permit that standalone non-status copy only in the text registry, never
      // in a status map / formatter or inline page copy; UI tests still require
      // the UNATTRIBUTED code in the rebate column when the dictionary lacks it.
      if (
        key === 'admin_dict.rebate_status.UNATTRIBUTED' &&
        name === '未归因' &&
        node.text === name &&
        file.fileName === registry &&
        ts.isPropertyAssignment(node.parent) &&
        !statusContext
      )
        continue;
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      violations.push(`${file.fileName}:${line + 1}: ${key} = ${node.text}`);
    }
  });
  return violations;
}

it('[AC-F1-07e-SOURCE#1] 实际使用 antd 表格、筛选、信息卡与 Result，不拼 ant 类名、不写字面色值或直接 fetch', () => {
  const expected = ['Table', 'Select', 'Input', 'Button', 'Card', 'Descriptions', 'Result'];
  const rendered = new Set<string>();
  const violations: string[] = [];
  for (const file of sources()) {
    const bindings = new Map<string, string>();
    for (const statement of file.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== 'antd' ||
        statement.importClause?.isTypeOnly
      )
        continue;
      const named = statement.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const entry of named.elements)
          if (!entry.isTypeOnly)
            bindings.set(entry.name.text, (entry.propertyName ?? entry.name).text);
      } else if (named && ts.isNamespaceImport(named)) {
        for (const component of expected)
          bindings.set(`${named.name.text}.${component}`, component);
      }
    }
    function component(tag: string): void {
      for (const [local, original] of bindings)
        if (tag === local || tag.startsWith(`${local}.`)) rendered.add(original);
    }
    visit(file, (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
        component(node.tagName.getText(file));
      if (
        ts.isCallExpression(node) &&
        /(?:^|\.)(?:createElement|jsx|jsxs|jsxDEV)$/.test(node.expression.getText(file)) &&
        node.arguments[0]
      )
        component(node.arguments[0].getText(file));
      if (ts.isIdentifier(node) && /^(fetch|XMLHttpRequest|getPrefixCls)$/.test(node.text))
        violations.push(`forbidden API ${node.text}`);
      if (
        (ts.isStringLiteralLike(node) &&
          !(
            (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) &&
            node.parent.moduleSpecifier === node
          )) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        if (/\bant-/.test(node.text)) violations.push(`handwritten antd class ${node.text}`);
        if (COLOR.test(node.text)) violations.push(`literal color ${node.text}`);
        if (
          ts.isPropertyAssignment(node.parent) &&
          /color|background|border|fill|stroke|shadow/i.test(node.parent.name.getText(file))
        )
          violations.push(...namedColors(node.text).map((name) => `named color ${name}`));
        if (/[\u3400-\u9fff]/u.test(node.text)) violations.push(`copy outside texts ${node.text}`);
      }
      if (ts.isJsxText(node) && /[\u3400-\u9fff]/u.test(node.text))
        violations.push(`JSX copy ${node.text}`);
    });
  }
  for (const path of files(directory).filter((path) => path.endsWith('.css'))) {
    const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/\bant-/.test(css) || COLOR.test(css)) violations.push(`forbidden CSS ${path}`);
    for (const declaration of css.matchAll(/(?:^|[;{])\s*[\w-]+\s*:\s*([^;{}]+)/g))
      violations.push(...namedColors(declaration[1]!).map((name) => `named CSS color ${name}`));
  }
  // Positive requirements keep the skeleton red before evaluating the negative guards.
  for (const name of expected) expect(rendered.has(name), name).toBe(true);
  expect(violations).toEqual([]);
});

it('[AC-F1-07e-SOURCE#2] 订单文案集中登记且不写死状态中文名，页面通过现有 data provider 或 admin API 请求', () => {
  const dictionary = join(root, 'texts/orders.ts');
  expect(existsSync(dictionary), 'orders text registry').toBe(true);
  const copy = readFileSync(dictionary, 'utf8');
  for (const text of [
    '订单查询',
    '订单详情',
    '基本信息',
    '归属信息',
    '分佣快照',
    '状态历史',
    '转链记录',
    '已锁定',
    '归属已锁定',
    '没有符合条件的订单',
    '列表加载失败',
    '重试',
  ])
    expect(copy).toContain(text);
  const registry = ts.createSourceFile(dictionary, copy, ts.ScriptTarget.Latest, true);
  expect([registry, ...sources()].flatMap((file) => hardcodedStatuses(file, dictionary))).toEqual(
    [],
  );
  const imports: string[] = [];
  const identifiers: string[] = [];
  for (const file of sources())
    visit(file, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        !node.importClause?.isTypeOnly &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (ts.isIdentifier(node)) identifiers.push(node.text);
    });
  expect(imports.some((path) => /texts\/orders\.ts$/.test(path))).toBe(true);
  expect(
    identifiers.includes('custom') ||
      identifiers.includes('useCustom') ||
      identifiers.includes('useList') ||
      imports.some((path) => /providers\/admin-api\.ts$/.test(path)),
  ).toBe(true);
});
