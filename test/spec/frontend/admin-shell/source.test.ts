// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

const moduleUrl = import.meta.url;
const sourceRoot = new URL('../../../../apps/admin/src/', moduleUrl);

function requiredSource(path: string): string {
  const url = new URL(path, sourceRoot);
  expect(existsSync(url), `required admin source: ${path}`).toBe(true);
  return readFileSync(url, 'utf8');
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}

function sourceFiles(directory = sourceRoot, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, directory), `${name}/`);
    return /\.(?:[cm]?[jt]sx?|css)$/.test(name) && !/\.(?:test|gen|d)\.[cm]?[jt]sx?$/.test(name)
      ? [name]
      : [];
  });
}

function ast(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

it('[AC-F1-06e-SOURCE#1] 实际 App 根使用 Refine 并显式关闭遥测，不能被后置属性覆盖', () => {
  // App.tsx is the task's fixed wiring point. Checking the imported JSX binding avoids a
  // comment, unrelated config object or a locally named imitation satisfying this assertion.
  const file = ast('App.tsx', requiredSource('App.tsx'));
  const bindings = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@refinedev/core'
    )
      continue;
    const imports = statement.importClause?.namedBindings;
    if (imports && ts.isNamedImports(imports)) {
      for (const element of imports.elements) {
        if ((element.propertyName ?? element.name).text === 'Refine')
          bindings.add(element.name.text);
      }
    }
  }
  const roots: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  visit(file, (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      bindings.has(node.tagName.getText(file))
    )
      roots.push(node);
  });
  expect(roots.length).toBeGreaterThan(0);
  for (const root of roots) {
    const attrs = root.attributes.properties;
    const index = attrs.findLastIndex(
      (attr) => ts.isJsxAttribute(attr) && attr.name.getText(file) === 'options',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(attrs.slice(index + 1).some(ts.isJsxSpreadAttribute)).toBe(false);
    const option = attrs[index];
    expect(option && ts.isJsxAttribute(option)).toBe(true);
    if (!option || !ts.isJsxAttribute(option)) return;
    const initializer = option.initializer;
    const expression =
      initializer && ts.isJsxExpression(initializer) ? initializer.expression : undefined;
    expect(expression && ts.isObjectLiteralExpression(expression)).toBe(true);
    if (!expression || !ts.isObjectLiteralExpression(expression)) return;
    const properties = expression.properties;
    const telemetryIndex = properties.findLastIndex(
      (property) => property.name?.getText(file).replace(/['"]/g, '') === 'disableTelemetry',
    );
    expect(telemetryIndex).toBeGreaterThanOrEqual(0);
    const telemetry = properties[telemetryIndex];
    expect(
      telemetry &&
        ts.isPropertyAssignment(telemetry) &&
        telemetry.initializer.kind === ts.SyntaxKind.TrueKeyword,
    ).toBe(true);
    expect(properties.slice(telemetryIndex + 1).some(ts.isSpreadAssignment)).toBe(false);
  }
});

it('[AC-F1-06e-SOURCE#2] 后台中文字面量只放 texts，包含 JSX 和模板字符串', () => {
  requiredSource('App.tsx');
  const files = sourceFiles();
  expect(files.some((path) => path.startsWith('texts/'))).toBe(true);
  const violations: string[] = [];
  for (const path of files.filter((path) => !path.startsWith('texts/') && !path.endsWith('.css'))) {
    const file = ast(path, requiredSource(path));
    visit(file, (node) => {
      if (
        (ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node) ||
          ts.isJsxText(node)) &&
        /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(node.text)
      ) {
        violations.push(
          `${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`,
        );
      }
    });
  }
  expect(violations).toEqual([]);
});

it('[AC-F1-06e-SOURCE#3] 后台源码与样式不含字面色值，允许令牌和 currentColor', () => {
  requiredSource('App.tsx');
  const violations: string[] = [];
  const probe = document.createElement('span');
  function check(value: string, path: string): void {
    const withoutTokens = value.replace(/var\(--[\w-]+\)/g, '').trim();
    if (
      /^(?:currentcolor|transparent|inherit|initial|unset|revert|revert-layer)$/i.test(
        withoutTokens,
      )
    )
      return;
    probe.style.color = '';
    probe.style.color = withoutTokens;
    if (
      probe.style.color !== '' ||
      /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i.test(withoutTokens)
    ) {
      violations.push(`${path}: ${value}`);
    }
  }
  for (const path of sourceFiles()) {
    const source = requiredSource(path);
    if (path.endsWith('.css')) {
      const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const declaration of css.matchAll(/[\w-]+\s*:\s*([^;{}]+)/g)) {
        check(declaration[1]!, path);
        // Detect named colors within shadows, borders and gradients too.
        for (const word of declaration[1]!.replace(/var\([^)]*\)/g, '').matchAll(/\b[a-z]+\b/gi))
          check(word[0], path);
      }
    } else {
      visit(ast(path, source), (node) => {
        if (
          ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)
        )
          check(node.text, path);
      });
    }
  }
  expect(violations).toEqual([]);
});
