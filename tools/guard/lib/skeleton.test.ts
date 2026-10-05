// Unit tests of the skeleton check (规划/11 §2.3 step 3; Codex reviews CR-05, CR2-01 of 2026-10-05).
import { expect, it } from 'vitest';
import { skeletonProblems } from './skeleton.ts';

const SHELL = [
  "import type { Clock } from './clock.ts';",
  "import { MESSAGES } from './messages.ts';",
  "export { MESSAGES } from './messages.ts';",
  '/** BR-X: the contract. Mentions NotImplemented in a comment. */',
  'export type Code = string;',
  'export interface Options { readonly clock: Clock }',
  'export class MaintenanceError extends Error {',
  '  readonly code: string;',
  '  constructor(code: string) {',
  '    super(MESSAGES[code]);',
  "    throw new Error('NotImplemented: MaintenanceError');",
  '  }',
  '  get detail(): string {',
  "    throw new Error('NotImplemented: detail');",
  '  }',
  '}',
  'export function split(total: number, parts: number): { a: number } {',
  '  void total;',
  '  void parts;',
  "  throw new Error('NotImplemented: split');",
  '}',
  'export async function later(x: number): Promise<number> {',
  "  throw new NotImplemented('later');",
  '}',
  '',
].join('\n');

const ts = (lines: string[]): string => `${lines.join('\n')}\n`;

it('[CR-05, CR2-01] accepts imports, re-exports, types and NotImplemented functions and classes', () => {
  expect(skeletonProblems('packages/money/src/split.ts', SHELL, null)).toEqual([]);
});

it('[CR-05] rejects an implemented function next to a placeholder in the same file', () => {
  const mixed = `${SHELL}export function round(a: number): number {\n  return Math.floor(a);\n}\n`;
  expect(skeletonProblems('packages/money/src/split.ts', mixed, null)).toEqual([
    "round: does not end with throw new NotImplemented(…) / Error('NotImplemented…')",
  ]);
});

it('[CR2-01] every executable top-level statement is refused, constants and aliases included', () => {
  for (const line of [
    'export const service = createService();',
    'export const calculate = Math.floor;',
    'export const LIMIT = 3_600_000;',
    'const table = Object.freeze({ a: 1 });',
    'let counter = 0;',
    'register();',
    'export default compute(1);',
    'export const g = (a: number): number => a * 2;',
    "export const h = function (): never { throw new Error('NotImplemented'); };",
  ]) {
    const problems = skeletonProblems('a/f.ts', ts([line]), null);
    expect(problems, line).toHaveLength(1);
    expect(problems[0], line).toContain('executable top-level code is not a skeleton');
  }
  // Class fields with an initializer, static blocks, computed names, parameter defaults.
  expect(
    skeletonProblems('a/f.ts', ts(['export class A {', '  rate = compute();', '}']), null),
  ).toEqual(['A.rate: a class field with an initializer runs code']);
  expect(
    skeletonProblems('a/f.ts', ts(['export class A {', '  static { run(); }', '}']), null),
  ).toEqual(['A: a static block runs code']);
  expect(
    skeletonProblems(
      'a/f.ts',
      ts([
        'export class A extends mixin(B) {',
        '  constructor() {',
        '    super();',
        "    throw new Error('NotImplemented');",
        '  }',
        '}',
      ]),
      null,
    ).join('\n'),
  ).toContain('extends must name a class');
  expect(
    skeletonProblems(
      'a/f.ts',
      ts(['export function f(a = run()): never {', "  throw new Error('NotImplemented');", '}']),
      null,
    ),
  ).toEqual(['f: parameter defaults run code; a skeleton has none']);
});

it('[CR-05] the keyword in a comment, dead code or a computed message is no skeleton', () => {
  expect(
    skeletonProblems(
      'a/f.ts',
      ts(['export function f(a: number): number {', '  // NotImplemented', '  return a + 1;', '}']),
      null,
    ),
  ).toHaveLength(1);
  expect(
    skeletonProblems(
      'a/f.ts',
      ts([
        'export function f(a: number): number {',
        '  if (a > 0) return a;',
        "  throw new Error('NotImplemented: f');",
        '}',
      ]),
      null,
    ).join('\n'),
  ).toContain('is not allowed');
  expect(
    skeletonProblems(
      'a/f.ts',
      ts([
        'export function f(a: number): never {',
        '  throw new Error(`NotImplemented ${a * 2}`);',
        '}',
      ]),
      null,
    ),
  ).toHaveLength(1);
  // this.x = … and super(…) outside a constructor are code.
  expect(
    skeletonProblems(
      'a/f.ts',
      ts([
        'export class A {',
        '  m(): void {',
        '    this.x = 1;',
        "    throw new Error('NotImplemented');",
        '  }',
        '}',
      ]),
      null,
    ),
  ).toHaveLength(1);
});

it('[CR2-01] the base exemption is bound to the symbol and its whole declaration', () => {
  const base = ts([
    'export const RATE = 5;',
    'export function done(a: number): number {',
    '  return a + 1;',
    '}',
  ]);
  const added = `${base}export function next(a: number): number {\n  void a;\n  throw new Error('NotImplemented: next');\n}\n`;
  expect(skeletonProblems('a/f.ts', added, base)).toEqual([]);
  // The same body under a new name is new code, not the old implementation.
  const copied = `${base}export function again(a: number): number {\n  return a + 1;\n}\n`;
  expect(skeletonProblems('a/f.ts', copied, base)).toHaveLength(1);
  // Same name, other parameters: changed.
  expect(
    skeletonProblems('a/f.ts', base.replace('done(a: number)', 'done(a: number, b: number)'), base),
  ).toHaveLength(1);
  // A changed constant is refused; an unchanged one is not.
  expect(skeletonProblems('a/f.ts', base.replace('RATE = 5', 'RATE = 6'), base)).toHaveLength(1);
  // An unchanged method of an existing class stays exempt; a new implemented one does not.
  const cls = ts(['export class A {', '  old(): number {', '    return 1;', '  }', '}']);
  const clsAdded = cls.replace(
    '  }\n}',
    "  }\n  next(): number {\n    throw new Error('NotImplemented: next');\n  }\n}",
  );
  expect(skeletonProblems('a/f.ts', clsAdded, cls)).toEqual([]);
  const clsBad = cls.replace('  }\n}', '  }\n  next(): number {\n    return 2;\n  }\n}');
  expect(skeletonProblems('a/f.ts', clsBad, cls)).toHaveLength(1);
});

it('[CR-05] only TypeScript or JavaScript modules can be skeletons', () => {
  expect(skeletonProblems('db/migrations/0009_x.sql', '-- NotImplemented\n', null)).toEqual([
    'not a TypeScript or JavaScript file: only NotImplemented skeleton modules go here',
  ]);
  expect(skeletonProblems('a/f.ts', 'export const = ;;; {', null)).toEqual([
    'cannot be read as erasable TypeScript (a skeleton must be)',
  ]);
});
