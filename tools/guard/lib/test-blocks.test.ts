// Unit tests of the test-block comparison of the red check (CT-06p; red check, 规划/11 §2.3
// step 3; orchestrator ruling of 2026-10-18 14:1x).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  type ComparedBlock,
  type Module,
  TestParseError,
  compareTestFile,
  cook,
  mayReadSupport,
  parseTestFile,
  relativeClosure,
  tokenize,
  unchangedTest,
} from './test-blocks.ts';

const HEADER = "import { describe, expect, it } from 'vitest';";
const src = (...lines: string[]): string => `${[HEADER, ...lines].join('\n')}\n`;
const test = (title: string, body = 'expect(1).toBe(1);'): string =>
  `it('${title}', () => {\n  ${body}\n});`;

function blocksOf(base: string, head: string): ComparedBlock[] {
  const c = compareTestFile(base, head);
  if (c.whole) throw new Error(`judged as a whole: ${c.reason}`);
  return c.blocks;
}

/** Title → changed, for the head blocks. */
function changes(base: string, head: string): Record<string, boolean> {
  return Object.fromEntries(blocksOf(base, head).map((b) => [b.title, b.changed]));
}

function whole(base: string, head: string): string {
  const c = compareTestFile(base, head);
  if (!c.whole) throw new Error('compared test by test');
  return c.reason;
}

it('[CT-06p] tokenize: comments and spacing drop out, line breaks, literals and regexes stay', () => {
  const tokens = tokenize("a = /x\\/(/g; // c\nb /* d */ = 'q' / 2;");
  expect(tokens.map((t) => [t.kind, t.text, t.nl])).toEqual([
    ['id', 'a', false],
    ['punct', '=', false],
    ['re', '/x\\/(/g', false],
    ['punct', ';', false],
    ['id', 'b', true],
    ['punct', '=', false],
    ['str', "'q'", false],
    ['punct', '/', false],
    ['num', '2', false],
    ['punct', ';', false],
  ]);
  const tpl = tokenize('`a${f(`b${c}`)}d`')[0];
  expect(tpl?.kind).toBe('tpl');
  expect(tpl?.parts).toEqual(['a', 'd']);
  // A regex after `)` is read as a division: a bracket in it breaks the bracket balance, and the
  // file is then judged as a whole (parseTestFile throws), never misread.
  expect(() => parseTestFile(src('if (x) /\\(/.test(y);'))).toThrow(TestParseError);
  expect(() => tokenize("it('unterminated\n")).toThrow(TestParseError);
  expect(() => tokenize('`open ${x')).toThrow(TestParseError);
  expect(() => tokenize('/* open')).toThrow(TestParseError);
});

it('[CT-06p] cook: string escapes decode exactly; an undecidable escape gives null', () => {
  expect(cook(String.raw`a\n\t\'\"\\\x41\u0042\u{43}`, false)).toBe('a\n\t\'"\\ABC');
  expect(cook('a\\\nb', false)).toBe('ab');
  expect(cook('a\r\nb', true)).toBe('a\nb');
  expect(cook(String.raw`\1`, false)).toBeNull();
  expect(cook(String.raw`\x4`, false)).toBeNull();
  expect(cook(String.raw`\08`, false)).toBeNull();
});

it('[CT-06p] parseTestFile: test blocks are the it / test calls imported from vitest', () => {
  const parsed = parseTestFile(
    [
      "import { describe, it as spec, test, type TestContext } from 'vitest';",
      "import { it as other } from './helpers.ts';",
      'const re = /x/;',
      "spec('[AC-1] plain', () => { expect(re.test('x')).toBe(true); });",
      "test.skip('[AC-2] skipped', () => {});",
      'spec.each([[1], [2]])(\'[AC-3] row %i\', (n) => { spec("inner", () => {}); });',
      "spec.each<[number, string]>([[1, 'a']])('[AC-4] typed $0', () => {});",
      "spec.each`\n  a\n  ${1}\n`('[AC-5] tagged $a', () => {});",
      "other('not vitest', () => {});",
      'const fixtures = spec.extend({ db: async ({}, use) => use(1) });',
      "describe('suite', () => {",
      "  spec(`[AC-6] ${'x'} in suite`, () => {});",
      "  describe.each(['p'])('inner %s', () => { spec('[AC-7] deep', () => {}); });",
      '});',
      'spec(name, () => {});',
    ].join('\n'),
  );
  expect(parsed.blocks.map((b) => b.title)).toEqual([
    '[AC-1] plain',
    '[AC-2] skipped',
    '[AC-3] row *',
    '[AC-4] typed *',
    '[AC-5] tagged *',
    'suite > [AC-6] * in suite',
    'suite > inner * > [AC-7] deep',
    '*',
  ]);
  // The fixture definition (it.extend) and the foreign `it` stay in the shared rest.
  expect(parsed.shared).toContain('spec . extend');
  expect(parsed.shared).toContain("other ( 'not vitest'");
  const [plain, , row, typed, , suite, deep, wild] = parsed.blocks;
  expect(plain?.pattern.test('[AC-1] plain')).toBe(true);
  expect(plain?.pattern.test('some suite > [AC-1] plain')).toBe(true); // unknown suite prefix
  expect(plain?.pattern.test('[AC-1] plain!')).toBe(false);
  expect(row?.pattern.test('[AC-3] row 2')).toBe(true);
  expect(typed?.pattern.test('[AC-4] typed 1')).toBe(true);
  expect(suite?.pattern.test('suite > [AC-6] x in suite')).toBe(true);
  expect(suite?.pattern.test('[AC-6] x in suite')).toBe(false);
  expect(deep?.pattern.test('suite > inner p > [AC-7] deep')).toBe(true);
  expect(wild?.pattern.test('anything at all')).toBe(true);
});

it('[CT-06p] real red-reporter names map to exactly their own block (vitest 5.0.1 run of a probe file)', () => {
  // The probe file ran under vitest 5.0.1 with the trusted red reporter: plain, template, each
  // (%i %s, $name %#), tagged-template each, a loop, describe and describe.each, .for, escapes.
  const dir = join(import.meta.dirname, 'red-check-fixtures');
  const source = readFileSync(join(dir, 'ct06p-probe.ts.txt'), 'utf8');
  const report = JSON.parse(readFileSync(join(dir, 'ct06p-probe-red.json'), 'utf8')) as {
    testResults: { assertionResults: { fullName: string }[] }[];
  };
  const names = report.testResults[0]?.assertionResults.map((t) => t.fullName) ?? [];
  expect(names).toHaveLength(15);
  const { blocks } = parseTestFile(source);
  for (const name of names) {
    expect(
      blocks.filter((b) => b.pattern.test(name)).map((b) => b.title),
      name,
    ).toHaveLength(1);
  }
  const same = blocksOf(source, source);
  expect(names.every((n) => unchangedTest(n, same))).toBe(true);
});

it('[CT-06p] B1-12f shape: an assertion changed in two tests marks only those two', () => {
  const base = src(test('[AC-1] a'), test('[AC-2] b'), test('[AC-3] c'), test('[AC-4] d'));
  const head = src(
    test('[AC-1] a', '// a new column\n  expect(2).toBe(2);'),
    test('[AC-2] b'),
    test('[AC-3] c'),
    test('[AC-4] d', 'expect([1, 2]).toEqual([1, 2]);'),
  );
  expect(changes(base, head)).toEqual({
    '[AC-1] a': true,
    '[AC-2] b': false,
    '[AC-3] c': false,
    '[AC-4] d': true,
  });
});

it('[CT-06p] comments and indentation do not count; a line break, a literal or a regex does', () => {
  const base = src(test('[AC-1] a', 'expect(f(1, 2)).toBe(3);'), test('[AC-2] b'));
  expect(
    changes(
      base,
      src(
        test('[AC-1] a', '/* why */ expect(f(1,   2)).toBe(3); // same'),
        '// a comment between tests',
        test('[AC-2] b'),
      ),
    ),
  ).toEqual({ '[AC-1] a': false, '[AC-2] b': false });
  const line = src(test('[AC-1] a', 'expect(f(1, 2))\n    .toBe(3);'), test('[AC-2] b'));
  expect(changes(base, line)['[AC-1] a']).toBe(true);
  const literal = src(test('[AC-1] a', "expect(f(1, 2)).toBe('3 ');"), test('[AC-2] b'));
  expect(changes(base, literal)['[AC-1] a']).toBe(true);
  const re = (r: string): string => src(test('[AC-1] a', `expect('x').toMatch(${r});`));
  expect(changes(re('/x/'), re('/x /'))['[AC-1] a']).toBe(true);
});

it('[CT-06p] a new test, inserted anywhere, is the only changed block', () => {
  const base = src(test('[AC-1] a'), test('[AC-2] b'));
  expect(changes(base, src(test('[AC-1] a'), test('[AC-9] new'), test('[AC-2] b')))).toEqual({
    '[AC-1] a': false,
    '[AC-9] new': true,
    '[AC-2] b': false,
  });
  expect(changes(base, src(test('[AC-1] a'), test('[AC-2] b'), test('[AC-9] new')))).toEqual({
    '[AC-1] a': false,
    '[AC-2] b': false,
    '[AC-9] new': true,
  });
});

it('[CT-06p] a renamed test is new; moved tests and duplicates count as changed', () => {
  const base = src(test('[AC-1] a'), test('[AC-2] b'), test('[AC-3] c'));
  // Renamed: the old title is gone, the new one is a new block.
  expect(changes(base, src(test('[AC-1] a'), test('[AC-2] b2'), test('[AC-3] c')))).toEqual({
    '[AC-1] a': false,
    '[AC-2] b2': true,
    '[AC-3] c': false,
  });
  // Moved: the order of the unchanged tests is kept by the longest run; the moved one changed.
  expect(changes(base, src(test('[AC-3] c'), test('[AC-1] a'), test('[AC-2] b')))).toEqual({
    '[AC-3] c': true,
    '[AC-1] a': false,
    '[AC-2] b': false,
  });
  // Two identical copies: neither has a unique counterpart.
  const dup = blocksOf(
    src(test('[AC-1] a'), test('[AC-1] a')),
    src(test('[AC-1] a'), test('[AC-1] a')),
  );
  expect(dup.map((b) => b.changed)).toEqual([true, true]);
});

it('[CT-06p] describe: moving a test into or between suites changes it; a renamed suite changes the file', () => {
  const base = src(
    test('[AC-1] a'),
    "describe('one', () => {",
    test('[AC-2] b'),
    '});',
    "describe('two', () => {",
    test('[AC-3] c'),
    '});',
  );
  const moved = src(
    "describe('one', () => {",
    test('[AC-1] a'),
    test('[AC-2] b'),
    '});',
    "describe('two', () => {",
    test('[AC-3] c'),
    '});',
  );
  expect(changes(base, moved)).toEqual({
    'one > [AC-1] a': true,
    'one > [AC-2] b': false,
    'two > [AC-3] c': false,
  });
  const across = src(
    test('[AC-1] a'),
    "describe('one', () => {",
    '});',
    "describe('two', () => {",
    test('[AC-2] b'),
    test('[AC-3] c'),
    '});',
  );
  expect(changes(base, across)['two > [AC-2] b']).toBe(true);
  expect(whole(base, base.replace("describe('two'", "describe('three'"))).toContain(
    'code outside the tests changed',
  );
});

it('[CT-06p] a changed row of an inline it.each table changes every case; a top-level table changes the file', () => {
  const each = (rows: string): string =>
    src(
      test('[AC-1] a'),
      `it.each(${rows})('[AC-2] row %s', (n) => {\n  expect(n).toBeTruthy();\n});`,
    );
  expect(changes(each('[[1], [2]]'), each('[[1], [3]]'))).toEqual({
    '[AC-1] a': false,
    '[AC-2] row *': true,
  });
  const table = (rows: string): string =>
    src(`const rows = ${rows};`, test('[AC-1] a'), "it.each(rows)('[AC-2] row %s', () => {});");
  expect(whole(table('[[1], [2]]'), table('[[1], [3]]'))).toContain('code outside the tests');
});

it('[CT-06p] imports, helpers, hooks and loops are shared: any change there changes the file', () => {
  const base = src('const helper = () => 1;', 'beforeEach(() => {});', test('[AC-1] a'));
  expect(whole(base, base.replace('() => 1', '() => 2'))).toContain('code outside the tests');
  expect(
    whole(base, base.replace('beforeEach(() => {});', 'beforeEach(() => { x(); });')),
  ).toContain('code outside the tests');
  expect(
    whole(base, base.replace(HEADER, "import { describe, expect, it, vi } from 'vitest';")),
  ).toContain('code outside the tests');
  expect(whole(base, `${base}const extra = 1;\n`)).toContain('code outside the tests');
  // A loop that generates tests: its header is shared.
  const loop = (xs: string): string =>
    src(`for (const x of ${xs}) {`, '  it(`[AC-1] ${x}`, () => { expect(x).toBeTruthy(); });', '}');
  expect(whole(loop("['a']"), loop("['a', 'b']"))).toContain('code outside the tests');
  expect(changes(loop("['a']"), loop("['a']"))).toEqual({ '[AC-1] *': false });
});

it('[CT-06p] a file that cannot be read as tests is judged as a whole', () => {
  const ok = src(test('[AC-1] a'));
  expect(whole("it('open\n", ok)).toContain('at the base cannot be read');
  expect(whole(ok, `${ok}const x = <div>don't</div>;\n`)).toContain('cannot be read as tests');
  expect(whole(ok, `${ok}f(;\n`.replace('f(;', 'f(]'))).toContain('cannot be read as tests');
});

it('[CT-06p] unchangedTest: exactly one matching block, and that block unchanged', () => {
  const base = src(test('[AC-1] a'), 'it(`[AC-2] ${n} b`, () => {});');
  const same = blocksOf(base, base);
  expect(unchangedTest('[AC-1] a', same)).toBe(true);
  expect(unchangedTest('[AC-2] 7 b', same)).toBe(true);
  expect(unchangedTest('[AC-3] unknown', same)).toBe(false);
  expect(unchangedTest('', same)).toBe(false);
  // A block whose title is not a literal matches every name: nothing it could share is exempt.
  const wild = src(test('[AC-1] a'), 'it(name, () => {});');
  const ambiguous = blocksOf(wild, wild);
  expect(unchangedTest('[AC-1] a', ambiguous)).toBe(false);
  // A changed block that matches keeps the test required even if another block matches too.
  const changed = blocksOf(
    base,
    src(test('[AC-1] a', 'expect(2).toBe(2);'), 'it(`[AC-2] ${n} b`, () => {});'),
  );
  expect(unchangedTest('[AC-1] a', changed)).toBe(false);
  expect(unchangedTest('[AC-2] x b', changed)).toBe(true);
});

const mod = (path: string, text: string): Module => {
  const [closure] = relativeClosure(
    path,
    (p) => (p === path ? text : null),
    () => true,
  );
  return closure as Module;
};

it('[CT-06p] relativeClosure follows relative code files the test code names, within the walk', () => {
  const files: Record<string, string> = {
    'test/spec/a/x.test.ts':
      "import { h } from './helpers.ts';\nimport { y } from '../../../apps/api/src/y.ts';\nconst u = new URL('./data.csv', import.meta.url);",
    'test/spec/a/helpers.ts': "export { k } from './deep/k.js';",
    'test/spec/a/deep/k.ts': 'export const k = 1;',
    'apps/api/src/y.ts': 'export const y = 1;',
  };
  const closure = relativeClosure(
    'test/spec/a/x.test.ts',
    (p) => files[p] ?? null,
    (p) => p.startsWith('test/'),
  );
  expect(closure.map((m) => m.path)).toEqual([
    'test/spec/a/x.test.ts',
    'test/spec/a/helpers.ts',
    'test/spec/a/deep/k.ts',
  ]);
});

it('[CT-06p] mayReadSupport: a support file named, loaded, listed or named after the test counts', () => {
  const file = 'test/spec/l/rules.test.ts';
  const plain = mod(file, "import { it } from 'vitest';\nit('x', () => {});");
  expect(mayReadSupport(file, 'test/spec/m/expected.csv', [plain])).toBeNull();
  expect(
    mayReadSupport(file, 'test/spec/l/expected.csv', [
      mod(file, "const u = new URL('./expected.csv', import.meta.url);"),
    ]),
  ).toContain('names expected.csv');
  expect(
    mayReadSupport(file, 'test/spec/l/expected.csv', [mod(file, "load(`${dir}/${'expected'}`);")]),
  ).toContain('names expected');
  expect(
    mayReadSupport(file, 'test/spec/l/rows.csv', [
      mod(file, 'for (const f of readdirSync(here)) load(f);'),
    ]),
  ).toContain('readdirSync');
  expect(
    mayReadSupport(file, 'test/spec/l/rows.csv', [
      mod(file, 'const m = await import(`./${n}.ts`);'),
    ]),
  ).toContain('computed name');
  expect(
    mayReadSupport(file, 'test/spec/l/rows.csv', [
      mod(file, 'const r = createRequire(import.meta.url);'),
    ]),
  ).toContain('createRequire');
  expect(
    mayReadSupport(file, 'test/spec/l/helpers.ts', [plain, mod('test/spec/l/helpers.ts', '')]),
  ).toContain('loads test/spec/l/helpers.ts');
  expect(mayReadSupport(file, 'test/spec/l/__snapshots__/rules.test.ts.snap', [plain])).toContain(
    'named after it',
  );
  expect(
    mayReadSupport(file, 'test/spec/l/__screenshots__/rules.test.ts/x.png', [plain]),
  ).toContain('named after it');
  expect(mayReadSupport(file, 'test/spec/l/rows.csv', [mod(file, "it('open\n")])).toContain(
    'cannot be read as code',
  );
  // A literal dynamic import is fine; an unrelated word is fine.
  expect(
    mayReadSupport(file, 'test/spec/l/rows.csv', [
      mod(file, "await import('./other.ts'); 'rowsx';"),
    ]),
  ).toBeNull();
});
