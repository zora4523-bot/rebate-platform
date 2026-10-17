import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

export type MachineName = 'order-platform' | 'order-rebate';
export interface Row {
  id: string;
  from: (string | null)[];
  event?: string | null;
  to: string;
  guard: string;
  test_id: string;
  kind?: string;
}
export interface Machine {
  name: string;
  field: string;
  states: string[];
  events: string[];
  transitions: Row[];
}

export const PLATFORM_STATES = ['DEPOSIT_PAID', 'PAID', 'RECEIVED', 'SETTLED', 'INVALID'];
export const PLATFORM_EVENTS = [
  'PLATFORM_DEPOSIT_PAID',
  'PLATFORM_PAID',
  'PLATFORM_RECEIVED',
  'PLATFORM_SETTLED',
  'PLATFORM_INVALID',
  'PLATFORM_RIGHTS',
  'PLATFORM_PUNISH',
];
export const REBATE_STATES = [
  'UNATTRIBUTED',
  'ESTIMATED',
  'WAITING',
  'CREDITED',
  'VOID',
  'CLAWED_BACK',
];
export const PLATFORM_IDS = Array.from({ length: 15 }, (_, i) => `P${i + 1}`);
export const REBATE_IDS = [
  'R1',
  'R2',
  'R3',
  'R3a',
  'R3b',
  'R4',
  'R5',
  'R5a',
  'R6',
  'R7',
  'R8',
  'R9',
  'R9b',
  'R10',
  'R11',
  'R12',
  'R13',
  'R14',
];

export function repoFile(path: string): URL {
  return new URL(`../../../../${path}`, import.meta.url);
}

export function readRequired(path: string): string {
  const file = repoFile(path);
  // 缺少实现资产必须报断言失败，不能因 ENOENT 造成无效的先红。
  expect(existsSync(file), `missing task artifact: ${path}`).toBe(true);
  return readFileSync(file, 'utf8');
}

export function yamlText(name: MachineName): string {
  return readRequired(`specs/state-machines/${name}.yaml`);
}

export function generatedText(name: MachineName): string {
  return readRequired(`packages/domain/src/state-machines/${name}.gen.ts`);
}

export function machine(name: MachineName): Machine {
  const parsed = parseYamlLite(yamlText(name));
  expect(parsed).toEqual(
    expect.objectContaining({
      name: expect.any(String),
      field: expect.any(String),
      states: expect.any(Array),
      events: expect.any(Array),
      transitions: expect.any(Array),
    }),
  );
  return parsed as Machine;
}

export function rowsFor(doc: Machine, id: string): Row[] {
  const rows = doc.transitions.filter((row) => row.id === id);
  expect(rows.length, `missing ${id}`).toBeGreaterThan(0);
  return rows;
}

export function generatedExports(source: string): Record<string, unknown> {
  const ast = ts.createSourceFile('machine.ts', source, ts.ScriptTarget.Latest, true);
  const forbidden: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier) ||
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      forbidden.push(node.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(forbidden, '生成物必须独立，且只用可擦除语法').toEqual([]);
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  expect(compiled.diagnostics ?? []).toEqual([]);
  const exports: Record<string, unknown> = {};
  runInNewContext(compiled.outputText, { exports }, { timeout: 1000 });
  return exports;
}
