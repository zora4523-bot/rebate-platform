// Unit tests of the skeleton check (规划/11 §2.3 step 3; Codex review CR-05 of 2026-10-05).
import { expect, it } from 'vitest';
import { skeletonProblems } from './skeleton.ts';

const SHELL = [
  "import type { Clock } from './clock.ts';",
  '/** BR-X: the contract. Mentions NotImplemented in a comment. */',
  'export const LIMIT = 3_600_000;',
  'export interface Options { readonly clock: Clock }',
  'export class MaintenanceError extends Error {',
  '  readonly code: string;',
  '  constructor(code: string) {',
  '    super(MESSAGES[code]);',
  '    this.code = code;',
  "    throw new Error('NotImplemented: MaintenanceError');",
  '  }',
  '}',
  'export function split(total: number, parts: number): { a: number } {',
  '  void total;',
  '  void parts;',
  "  throw new Error('NotImplemented: split');",
  '}',
  'export const later = async (x: number): Promise<number> => {',
  "  throw new NotImplemented('later');",
  '};',
  '',
].join('\n');

it('[CR-05] accepts the shells the rule tests import, with types, constants and comments', () => {
  expect(skeletonProblems('packages/money/src/split.ts', SHELL, null)).toEqual([]);
});

it('[CR-05] rejects an implemented function next to a placeholder in the same file', () => {
  const mixed = `${SHELL}export function round(a: number): number {\n  return Math.floor(a);\n}\n`;
  expect(skeletonProblems('packages/money/src/split.ts', mixed, null)).toEqual([
    "round: does not end with throw new NotImplemented(…) / Error('NotImplemented…')",
  ]);
});

it('[CR-05] the keyword in a comment or in dead code is no skeleton', () => {
  const comment = [
    'export function f(a: number): number {',
    '  // NotImplemented',
    '  return a + 1;',
    '}',
    '',
  ].join('\n');
  expect(skeletonProblems('a/f.ts', comment, null)).toHaveLength(1);
  const before = [
    'export function f(a: number): number {',
    '  if (a > 0) return a;',
    "  throw new Error('NotImplemented: f');",
    '}',
    '',
  ].join('\n');
  expect(skeletonProblems('a/f.ts', before, null).join('\n')).toContain('is not allowed');
  // A template with an expression and an expression-bodied arrow are implementation.
  expect(
    skeletonProblems(
      'a/f.ts',
      'export function f(a: number): never {\n  throw new Error(`NotImplemented ${a * 2}`);\n}\n',
      null,
    ),
  ).toHaveLength(1);
  expect(
    skeletonProblems('a/f.ts', 'export const g = (a: number): number => a * 2;\n', null),
  ).toEqual(['arrow function: an arrow function with an expression body is an implementation']);
  // Nested code inside a shell, and a call before the throw.
  expect(
    skeletonProblems(
      'a/f.ts',
      "export function f(): void {\n  this.x = () => 1;\n  throw new Error('NotImplemented');\n}\n",
      null,
    ),
  ).toHaveLength(1);
  expect(
    skeletonProblems(
      'a/f.ts',
      "export function f(): void {\n  log('x');\n  throw new Error('NotImplemented');\n}\n",
      null,
    ),
  ).toHaveLength(1);
});

it('[CR-05] bodies unchanged against the base are not looked at; changed ones are', () => {
  const base = 'export function done(a: number): number {\n  return a + 1;\n}\n';
  const added = `${base}export function next(a: number): number {\n  void a;\n  throw new Error('NotImplemented: next');\n}\n`;
  expect(skeletonProblems('a/f.ts', added, base)).toEqual([]);
  const changed = added.replace('return a + 1;', 'return a + 2;');
  expect(skeletonProblems('a/f.ts', changed, base)).toHaveLength(1);
});

it('[CR-05] only TypeScript or JavaScript modules can be skeletons', () => {
  expect(skeletonProblems('db/migrations/0009_x.sql', '-- NotImplemented\n', null)).toEqual([
    'not a TypeScript or JavaScript file: only NotImplemented skeleton modules go here',
  ]);
  expect(skeletonProblems('a/f.ts', 'export const = ;;; {', null)).toEqual([
    'cannot be read as erasable TypeScript (a skeleton must be)',
  ]);
});
