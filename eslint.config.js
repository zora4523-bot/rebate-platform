// ESLint flat config (ESLint 10 + typescript-eslint 8).
// Protected path, class 2 (verify config): changing it needs owner approval (规划/11 §4.4).
import tseslint from 'typescript-eslint';

const TS_FILES = ['**/*.ts', '**/*.mts', '**/*.cts'];
const TEST_FILES = ['**/*.test.ts', 'test/**/*.ts'];
const FUNDS_PURE_FILES = ['packages/money/**/*.ts', 'packages/domain/**/*.ts'];

// 规划/11 §4.1: no `.skip` / `.only` (any chained form, e.g. `describe.only`, `it.skip.each`,
// `ctx.skip()`), no conditional skipping, no `.todo` placeholders.
const NO_SKIP_OR_ONLY = [
  {
    selector:
      "MemberExpression[property.type='Identifier'][property.name=/^(only|skip|skipIf|runIf|todo)$/]",
    message: 'Tests must not be skipped, focused or left as todo (规划/11 §4.1).',
  },
  {
    selector:
      "MemberExpression[computed=true][property.type='Literal'][property.value=/^(only|skip|skipIf|runIf|todo)$/]",
    message: 'Tests must not be skipped, focused or left as todo (规划/11 §4.1).',
  },
];

// 规划/11 §4.2 clock guard + AGENTS.md hard rule 1 (integer money, no floating point).
const NO_WALL_CLOCK_OR_FLOAT = [
  {
    selector: "NewExpression[callee.name='Date']",
    message: 'No `new Date(` in money/domain: time comes from the injected Clock (规划/11 §4.2).',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'No `Date.now(` in money/domain: time comes from the injected Clock (规划/11 §4.2).',
  },
  {
    selector:
      "CallExpression[callee.property.name='slice'][callee.object.type='CallExpression'][callee.object.callee.property.name='toISOString']",
    message:
      'No `toISOString().slice`: derive dates with accountingDate()/settlePeriod() (规划/11 §4.2).',
  },
  {
    selector: "CallExpression[callee.name='parseFloat']",
    message: 'No floating point in money/domain: amounts are bigint fen.',
  },
  {
    selector: "MemberExpression[object.name='Number'][property.name='parseFloat']",
    message: 'No floating point in money/domain: amounts are bigint fen.',
  },
  {
    selector: "CallExpression[callee.property.name='toFixed']",
    message: 'No floating point in money/domain: amounts are bigint fen.',
  },
];

// Conventions C12 / apps/api/AGENTS.md: application code reads time only through the injected
// Clock; the clock module itself is the single place that touches the wall clock.
const NO_WALL_CLOCK_IN_APP = [
  {
    selector: "NewExpression[callee.name='Date']",
    message: 'No `new Date(` in app code: use the injected Clock (modules/platform/clock).',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'No `Date.now(` in app code: use the injected Clock (modules/platform/clock).',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.tmp/**',
      '**/.turbo/**',
      '**/*.gen.ts',
      '**/coverage/**',
      '**/reports/**',
    ],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    files: TS_FILES,
    extends: [tseslint.configs.recommended],
  },
  {
    // Type-aware rules only where promises matter at runtime: app and library sources.
    files: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    // Application code logs through pino only; CLIs under tools/ and scripts/ may print.
    files: ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.js', '**/*.mjs', '**/*.cjs'],
    ignores: ['tools/**', '**/scripts/**'],
    rules: { 'no-console': 'error' },
  },
  {
    files: TEST_FILES,
    ignores: FUNDS_PURE_FILES,
    rules: { 'no-restricted-syntax': ['error', ...NO_SKIP_OR_ONLY] },
  },
  {
    files: FUNDS_PURE_FILES,
    ignores: TEST_FILES,
    rules: { 'no-restricted-syntax': ['error', ...NO_WALL_CLOCK_OR_FLOAT] },
  },
  {
    files: ['apps/api/**/*.ts'],
    ignores: ['apps/api/src/modules/platform/clock/**', 'apps/api/scripts/**', ...TEST_FILES],
    rules: { 'no-restricted-syntax': ['error', ...NO_WALL_CLOCK_IN_APP] },
  },
  {
    // A later `no-restricted-syntax` entry replaces an earlier one, so money/domain tests get
    // both lists in a single entry.
    files: ['packages/money/**/*.test.ts', 'packages/domain/**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...NO_SKIP_OR_ONLY, ...NO_WALL_CLOCK_OR_FLOAT] },
  },
);
