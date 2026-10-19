import { generateTokensCss, type DesignTokens } from '@couli/ui-tokens';
import ts from 'typescript';
import { expect } from 'vitest';
import { block, declarations, record, withoutComments } from './kit.ts';

// Unsupported v0.4.0 input must be reported as an assertion, not an uncaught generator error.
export function succeeds<T>(operation: () => T): T {
  let result: T | undefined;
  expect(() => {
    result = operation();
  }).not.toThrow();
  return result as T;
}

export function generatedCss(input: DesignTokens): string {
  return succeeds(() => generateTokensCss(input));
}

export function darkBlocks(css: string): [Map<string, string>, Map<string, string>] {
  const clean = withoutComments(css);
  const system =
    /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^{}]*)\}\s*\}/g;
  const explicit = /:root\[data-theme="dark"\]\s*\{([^{}]*)\}/g;
  const result: [Map<string, string>, Map<string, string>] = [
    declarations(block(clean, system)),
    declarations(block(clean, explicit)),
  ];
  // Only the light block and the two ordered dark blocks may affect the cascade.
  expect(
    clean
      .replace(/:root\s*\{[^{}]*\}/g, '')
      .replace(system, '')
      .replace(explicit, '')
      .trim(),
  ).toBe('');
  const lightIndex = clean.search(/:root\s*\{/);
  expect(lightIndex).toBeGreaterThanOrEqual(0);
  expect(lightIndex).toBeLessThan(clean.search(system));
  expect(clean.search(system)).toBeLessThan(clean.search(explicit));
  return result;
}

export interface Leaf {
  path: string[];
  variable: string;
  token: Record<string, unknown>;
}

export function leaves(node: unknown, path: string[] = []): Leaf[] {
  const object = record(node);
  if ('type' in object && 'value' in object)
    return [{ path, variable: `--${path.join('-')}`, token: object }];
  return Object.entries(object).flatMap(([key, child]) => leaves(child, [...path, key]));
}

// Accept nested or flattened themes, arbitrary export/container names, and either source values
// or CSS-converted values. The choice must be consistent across every token in a theme.
export function expectValueTheme(
  exports: unknown,
  input: DesignTokens,
  mode: 'light' | 'dark',
  css: Map<string, string>,
): void {
  const all = leaves(input.tokens);
  const expectedRaw = Object.fromEntries(
    all.map(({ variable, token }) => [
      variable,
      mode === 'dark' && 'dark' in token ? token.dark : token.value,
    ]),
  );
  const expectedCss = Object.fromEntries(all.map(({ variable }) => [variable, css.get(variable)]));
  const candidates: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
    const object = node as Record<string, unknown>;
    for (const shape of ['nested', 'dotted', 'variable'] as const) {
      const values: Record<string, unknown> = {};
      for (const { path, variable } of all) {
        let value: unknown = object;
        const keys = shape === 'nested' ? path : [shape === 'dotted' ? path.join('.') : variable];
        for (const key of keys) {
          value =
            typeof value === 'object' && value !== null
              ? (value as Record<string, unknown>)[key]
              : undefined;
        }
        values[variable] = value;
      }
      candidates.push(values);
    }
    Object.values(object).forEach(visit);
  };
  visit(exports);
  expect(
    candidates.some((candidate) => {
      // Vitest's asymmetric matcher provides structural equality, including arrays of shadows.
      return (
        expect.objectContaining(expectedRaw).asymmetricMatch(candidate) ||
        expect.objectContaining(expectedCss).asymmetricMatch(candidate)
      );
    }),
    `every ${mode} token must resolve to its source value`,
  ).toBe(true);
}

// Read generated data without executing generated source. Supports literal objects, arrays,
// as const / satisfies, references and spreads; public export names are deliberately free.
export function serializedExports(source: string): Record<string, unknown> {
  const file = ts.createSourceFile('theme.gen.ts', source, ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, ts.Expression>();
  const exported = new Set<string>();
  const defaults: ts.Expression[] = [];
  for (const statement of file.statements) {
    if (ts.isExportAssignment(statement)) defaults.push(statement.expression);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          bindings.set(declaration.name.text, declaration.initializer);
          if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
            exported.add(declaration.name.text);
        }
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const item of statement.exportClause.elements)
        exported.add((item.propertyName ?? item.name).text);
    }
  }
  const read = (node: ts.Expression, seen = new Set<string>()): unknown => {
    if (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node)
    )
      return read(node.expression, seen);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken)
      return -Number(read(node.operand, seen));
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const bound = bindings.get(node.text);
      if (bound) return read(bound, new Set([...seen, node.text]));
    }
    if (ts.isArrayLiteralExpression(node))
      return node.elements.map((element) => read(element, seen));
    if (ts.isObjectLiteralExpression(node)) {
      const value: Record<string, unknown> = {};
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) Object.assign(value, read(property.expression, seen));
        else if (ts.isShorthandPropertyAssignment(property))
          value[property.name.text] = read(property.name, seen);
        else if (
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) ||
            ts.isStringLiteralLike(property.name) ||
            ts.isNumericLiteral(property.name))
        )
          value[property.name.text] = read(property.initializer, seen);
      }
      return value;
    }
    return undefined;
  };
  return Object.fromEntries(
    [...exported]
      .map((name): [string, unknown] => {
        const value = bindings.get(name);
        return [name, value ? read(value) : undefined];
      })
      .concat(defaults.map((value): [string, unknown] => ['default', read(value)])),
  );
}
