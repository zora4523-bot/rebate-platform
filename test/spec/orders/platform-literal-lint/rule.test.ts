import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { platform } from '../../../../packages/contracts-ts/src/index.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const RULE = 'no-restricted-syntax';
const ORDERS = 'apps/api/src/modules/orders';
const APP = `${ORDERS}/application/platform-literal-probe.ts`;
const ORDERS_SOURCES = [
  APP,
  `${ORDERS}/domain/platform-literal-probe.ts`,
  `${ORDERS}/http/admin/platform-literal-probe.ts`,
  `${ORDERS}/platform-literal-probe.ts`,
];
const TIMEOUT = 60_000;

// Only `no-restricted-syntax` runs, with the entries eslint.config.js gives each path. The probe
// paths do not exist on disk, so no tsconfig program holds them: type-aware parsing is switched
// off, and the type-aware rules are filtered out with it.
const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: join(repoRoot, 'eslint.config.js'),
  overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
  ruleFilter: ({ ruleId }) => ruleId === RULE,
});

/** Sorted distinct lines of the `no-restricted-syntax` reports for `code` linted as `path`. */
async function reportedLines(code: string, path: string): Promise<number[]> {
  const results = await eslint.lintText(code, { filePath: join(repoRoot, path) });
  const messages = results.flatMap((result) => result.messages);
  expect(
    messages.filter((message) => message.fatal === true),
    path,
  ).toEqual([]);
  const lines = messages.filter((message) => message.ruleId === RULE).map((m) => m.line);
  return [...new Set(lines)].sort((a, b) => a - b);
}

function lineOf(code: string, fragment: string): number {
  const index = code.split('\n').findIndex((line) => line.includes(fragment));
  expect(index, fragment).toBeGreaterThanOrEqual(0);
  return index + 1;
}

// The comparison sits on line 2 of the first two forms, the `case` on line 3 of the third.
function equal(name: string): string {
  return `export function probe(x: string): boolean {\n  return x === '${name}';\n}\n`;
}
function notEqual(name: string): string {
  return `export function probe(x: string): boolean {\n  return '${name}' !== x;\n}\n`;
}
function switchCase(name: string): string {
  return [
    'export function probe(x: string): number {',
    '  switch (x) {',
    `    case '${name}':`,
    '      return 1;',
    '    default:',
    '      return 0;',
    '  }',
    '}',
    '',
  ].join('\n');
}

type Forms = { '===': number[]; '!==': number[]; case: number[] };
const REPORTED: Forms = { '===': [2], '!==': [2], case: [3] };
const SILENT: Forms = { '===': [], '!==': [], case: [] };

async function forms(path: string, names: [string, string, string]): Promise<Forms> {
  return {
    '===': await reportedLines(equal(names[0]), path),
    '!==': await reportedLines(notEqual(names[1]), path),
    case: await reportedLines(switchCase(names[2]), path),
  };
}

/** Token texts of a script with comments dropped. */
function codeTokens(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const tokens: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    tokens.push(scanner.getTokenText());
  }
  return tokens.join(' ');
}

it(
  'orders 非测试源码里 x === 平台名、平台名 !== x、case 平台名: 三种写法都报 no-restricted-syntax',
  async () => {
    const seen: Record<string, Forms> = {};
    const expected: Record<string, Forms> = {};
    for (const path of ORDERS_SOURCES) {
      seen[path] = await forms(path, ['jd', 'pdd', 'taobao']);
      expected[path] = REPORTED;
    }
    expect(seen).toEqual(expected);
  },
  TIMEOUT,
);

it(
  '契约枚举 platform 的每个平台名都报，且 eslint.config.js 里没有手抄的平台名',
  async () => {
    expect(platform.length).toBeGreaterThan(0);
    const seen: Record<string, Forms> = {};
    const expected: Record<string, Forms> = {};
    for (const name of platform) {
      seen[name] = await forms(APP, [name, name, name]);
      expected[name] = REPORTED;
    }
    expect(seen).toEqual(expected);
    const config = codeTokens(readFileSync(join(repoRoot, 'eslint.config.js'), 'utf8'));
    const copied = platform.filter((name) =>
      new RegExp(`(?<![\\w$-])${name}(?![\\w$-])`).test(config),
    );
    expect(copied, 'platform names must come from the contract enum').toEqual([]);
  },
  TIMEOUT,
);

it(
  '非平台名字符串的 ===、!==、case 不报（同一写法换成平台名则报）',
  async () => {
    expect(await reportedLines(equal('jd'), APP)).toEqual([2]);
    const seen: Record<string, Forms> = {};
    const expected: Record<string, Forms> = {};
    for (const other of ['paid', 'JD', 'Taobao', 'jdx', 'xjd', 'pdd-mall', 'tao', '']) {
      seen[other] = await forms(APP, [other, other, other]);
      expected[other] = SILENT;
    }
    expect(seen).toEqual(expected);
  },
  TIMEOUT,
);

it(
  '日志文案、对象键、类型标注、as const 常量、实参、数组元素、默认值里的平台名不报，只报同文件里的比较',
  async () => {
    const code = [
      "export type ProbePlatform = 'jd' | 'pdd';",
      "export const PROBE_PLATFORMS = ['taobao', 'jd', 'pdd'] as const;",
      "export const PROBE_LABELS = { jd: 'JD', 'pdd': 'PDD', ['taobao']: 'Taobao' };",
      'export function probe(',
      '  x: string,',
      '  log: { info(fields: object, message: string): void },',
      '  pick: (name: string) => number,',
      "  fallback: 'vip' = 'vip',",
      '): number {',
      "  log.info({ platform: 'douyin' }, 'sync jd orders');",
      "  log.info({}, 'jd');",
      "  const chosen: string = 'meituan';",
      "  const names: string[] = ['eleme', chosen];",
      "  if (x === 'jd') return pick('kuaishou');",
      "  return pick('suning') + pick(fallback) + names.length + PROBE_PLATFORMS.length;",
      '}',
      '',
    ].join('\n');
    expect(await reportedLines(code, APP)).toEqual([lineOf(code, "x === 'jd'")]);
  },
  TIMEOUT,
);

it(
  'platform-rules 目录与 orders 测试文件里同样的比较不报；platform-rules 仍禁 new Date / Date.now',
  async () => {
    expect(await reportedLines(equal('jd'), APP)).toEqual([2]);
    const exempt = [
      `${ORDERS}/domain/platform-rules/platform-literal-probe.ts`,
      `${ORDERS}/domain/platform-rules/nested/platform-literal-probe.ts`,
      `${ORDERS}/application/platform-literal-probe.test.ts`,
      `${ORDERS}/domain/platform-literal-probe.test.ts`,
    ];
    const seen: Record<string, Forms> = {};
    const expected: Record<string, Forms> = {};
    for (const path of exempt) {
      seen[path] = await forms(path, ['jd', 'pdd', 'taobao']);
      expected[path] = SILENT;
    }
    expect(seen).toEqual(expected);
    const wallClock = [
      'export function probe(): number {',
      '  const now = Date.now();',
      '  return now + new Date().getTime();',
      '}',
      '',
    ].join('\n');
    for (const path of exempt.slice(0, 2)) {
      expect(await reportedLines(wallClock, path), path).toEqual([2, 3]);
    }
  },
  TIMEOUT,
);

it(
  'orders 之外（union、linking、orders 同名前缀目录、apps/api/src 根）的同样比较不报',
  async () => {
    expect(await reportedLines(equal('jd'), APP)).toEqual([2]);
    const outside = [
      'apps/api/src/modules/union/platform-literal-probe.ts',
      'apps/api/src/modules/linking/platform-literal-probe.ts',
      'apps/api/src/modules/orders-probe/platform-literal-probe.ts',
      'apps/api/src/platform-literal-probe.ts',
    ];
    const seen: Record<string, Forms> = {};
    const expected: Record<string, Forms> = {};
    for (const path of outside) {
      seen[path] = await forms(path, ['jd', 'pdd', 'taobao']);
      expected[path] = SILENT;
    }
    expect(seen).toEqual(expected);
  },
  TIMEOUT,
);

it(
  'orders 非测试源码里平台名比较与 new Date / Date.now 同时报（NO_WALL_CLOCK_IN_APP 未被覆盖）',
  async () => {
    const code = [
      'export function probe(x: string): number {',
      "  if (x === 'jd') return 0;",
      '  const now = Date.now();',
      '  return now + new Date().getTime();',
      '}',
      '',
    ].join('\n');
    const seen: Record<string, number[]> = {};
    const expected: Record<string, number[]> = {};
    for (const path of ORDERS_SOURCES) {
      seen[path] = await reportedLines(code, path);
      expected[path] = [2, 3, 4];
    }
    expect(seen).toEqual(expected);
  },
  TIMEOUT,
);

it(
  'orders 测试文件仍只走 NO_SKIP_OR_ONLY：focused 测试报，new Date 与平台名比较不报',
  async () => {
    expect(await reportedLines(equal('jd'), APP)).toEqual([2]);
    const focused = 'only';
    const code = [
      "import { it } from 'vitest';",
      '',
      `it.${focused}('probe', () => {`,
      '  const x = String(new Date().getTime() + Date.now());',
      "  if (x === 'jd') return;",
      '});',
      '',
    ].join('\n');
    for (const path of [
      `${ORDERS}/application/platform-literal-probe.test.ts`,
      `${ORDERS}/domain/platform-literal-probe.test.ts`,
    ]) {
      expect(await reportedLines(code, path), path).toEqual([3]);
    }
  },
  TIMEOUT,
);

it(
  '主干 orders 现有文件（源码、测试与 platform-rules）lint 后没有 no-restricted-syntax 报错',
  async () => {
    expect(await reportedLines(equal('jd'), APP)).toEqual([2]);
    const results = await eslint.lintFiles([ORDERS]);
    expect(results.length).toBeGreaterThan(0);
    const offenders = results.flatMap((result) =>
      result.messages
        .filter((message) => message.ruleId === RULE || message.fatal === true)
        .map((m) => `${relative(repoRoot, result.filePath)}:${m.line} ${m.message}`),
    );
    expect(offenders).toEqual([]);
  },
  2 * TIMEOUT,
);
