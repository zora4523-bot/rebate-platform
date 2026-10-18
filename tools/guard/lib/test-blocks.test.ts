// Unit tests of the test-block comparison of the red check (CT-06p; red check, 规划/11 §2.3
// step 3; orchestrator ruling of 2026-10-18 14:1x).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  type ComparedBlock,
  type Module,
  type ModuleImport,
  type PathKind,
  TestParseError,
  compareTestFile,
  cook,
  listedDirectories,
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
      "test.concurrent('[AC-2] concurrent', () => {});",
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
    '[AC-2] concurrent',
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
  // A regex the lexer reads as a division (after the `)` of an `if`) keeps its spaces: a line
  // with a division is compared with its exact spacing (Codex review r3, S2).
  const after = (r: string): string =>
    src(test('[AC-1] a', `if (true) ${r}.test('a  b') || expect.fail('mismatch');`));
  expect(changes(after('/a b/'), after('/a  b/'))['[AC-1] a']).toBe(true);
  expect(changes(after('/a b/'), after('/a b/'))['[AC-1] a']).toBe(false);
  const division = (d: string): string => src(test('[AC-1] a', `expect(${d}).toBe(2);`));
  expect(changes(division('4 / 2'), division('4  /  2'))['[AC-1] a']).toBe(true);
  expect(changes(division('4 / 2'), division('4 / /* two */ 2'))['[AC-1] a']).toBe(true);
  expect(changes(division('4 / 2'), division('4 / 2'))['[AC-1] a']).toBe(false);
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
  // Two describes with the same header are different suites (Codex review r1, S2).
  const twins = (first: string, second: string): string =>
    src(
      "describe('same', () => {",
      'const k = 1;',
      first,
      '});',
      "describe('same', () => {",
      'const k = 2;',
      second,
      '});',
    );
  expect(changes(twins(test('[AC-1] a'), ''), twins('', test('[AC-1] a')))).toEqual({
    'same > [AC-1] a': true,
  });
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
  // A block moved into another loop (or branch, function …) with the same text is a different
  // block: its place in the shared rest changed (Codex review r2, S2).
  const loops = (first: string, second: string): string =>
    src('for (const n of [1]) {', first, '}', 'for (const n of [2, 3]) {', second, '}');
  const inLoop = 'it(`[AC-1] case ${n}`, () => {\n  expect(n).toBeGreaterThan(0);\n});';
  expect(changes(loops(inLoop, ''), loops('', inLoop))).toEqual({ '[AC-1] case *': true });
  expect(changes(loops(inLoop, ''), loops(inLoop, ''))).toEqual({ '[AC-1] case *': false });
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
  // CT-06r (B1-12g): a same-named test in another directory is another test, not a snapshot.
  expect(mayReadSupport(file, 'test/spec/other/rules.test.ts', [plain])).toBeNull();
  expect(
    mayReadSupport(file, 'test/spec/other/__snapshots__/rules.test.ts.snap', [plain]),
  ).toBeNull();
  expect(mayReadSupport(file, 'test/spec/l/sub/rules.test.ts.snap', [plain])).toContain(
    'named after it',
  );
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

// CT-06r (after B1-12g): directory listings are resolved statically; only a listing of a directory
// that holds the support file (or one that cannot be resolved) makes the test file read it.
const FIXTURES = join(import.meta.dirname, 'red-check-fixtures');
const listed = (path: string, text: string) => listedDirectories(tokenize(text), path);

it('[CT-06r] listedDirectories resolves literals, constants, path.join / resolve / dirname, URLs and function parameters', () => {
  const file = 'test/spec/platform/queue/contract.test.ts';
  // The B1-12g shape: constants from import.meta.url, a recursive helper called twice.
  expect(
    listed(
      file,
      `import path from 'node:path';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.resolve(HERE, '../../../../apps/api/src');
const QUEUE_DIR = path.join(API_SRC, 'modules/platform/queue');
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return [full];
  });
}
const a = tsFiles(API_SRC);
const b = tsFiles(QUEUE_DIR);
`,
    ),
  ).toEqual({ dirs: ['apps/api/src', 'apps/api/src/modules/platform/queue'], unresolved: null });
  // Literals, __dirname, import.meta.dirname, new URL, join / resolve with literal segments, a
  // parenthesised expression, .pathname of a URL, an arrow function parameter.
  expect(
    listed(
      'test/spec/a/x.test.ts',
      `const ROOT = new URL('../../', import.meta.url);
const D1 = join(__dirname, 'data');
const D2 = resolve(import.meta.dirname, '..', 'shared');
readdirSync(D1, { withFileTypes: true });
readdirSync((D2));
readdirSync(new URL('./seeds/', ROOT).pathname);
readdirSync(fileURLToPath(new URL('./pages', import.meta.url)));
const list = (p: string) => { for (const e of readdirSync(new URL(p, ROOT))) use(e); };
list('./db/migrations');
`,
    ),
  ).toEqual({
    dirs: [
      'test/db/migrations',
      'test/seeds',
      'test/spec/a/data',
      'test/spec/a/pages',
      'test/spec/shared',
    ],
    unresolved: null,
  });
  // Not resolved: a computed directory, a parameter never called from outside, a bare literal
  // without ./ (the working directory is unknown), a path above the repository, a listing inside a
  // template expression, a call without arguments.
  const cases: [string, string][] = [
    ['readdirSync(process.cwd());', 'cannot be resolved statically'],
    // Codex review r1, S2: a file-system path literal is relative to the working directory, which
    // is not known — not to the module.
    ["readdirSync('./fixtures');", 'cannot be resolved statically'],
    ["readdirSync('./test/spec/a/data');", 'cannot be resolved statically'],
    ["readdirSync(join('./x', 'data'));", 'cannot be resolved statically'],
    ["function f(d) { return readdirSync(d); }\nf('./data');", 'cannot be resolved statically'],
    // Codex review r1, S2: a constant whose initialiser goes on past the resolved part is unknown.
    [
      "const D = new URL('./unused/', import.meta.url).pathname.replace('unused', 'data');\nreaddirSync(D);",
      'cannot be resolved statically',
    ],
    ["const D = join(__dirname, 'a') + '/b';\nreaddirSync(D);", 'cannot be resolved statically'],
    ["const D = join(__dirname, 'a').slice(1);\nreaddirSync(D);", 'cannot be resolved statically'],
    // Codex review r3, S2: a name declared twice (a same-named local elsewhere) is no constant.
    [
      "const D = join(__dirname, 'data');\nfunction unused() { const D = join(__dirname, 'other'); }\nreaddirSync(D);",
      'cannot be resolved statically',
    ],
    // Codex review r3, S2: a recursive call that may leave the listed tree is not resolved.
    [
      "function scan(d, up) { const rows = readdirSync(d); if (up) scan(dirname(d), false); return rows; }\nscan(join(__dirname, 'data'), true);",
      'cannot be resolved statically',
    ],
    [
      "function scan(d) { for (const n of readdirSync(d)) scan(join(__dirname, n)); }\nscan(join(__dirname, 'data'));",
      'cannot be resolved statically',
    ],
    // Codex review r2, S2: a reassigned name is no constant.
    [
      "let D = join(__dirname, 'a');\nD = somewhere();\nreaddirSync(D);",
      'cannot be resolved statically',
    ],
    [
      'function f(d) { return readdirSync(d); }',
      'in f() on a directory that cannot be resolved statically',
    ],
    ["readdirSync('db/migrations');", 'cannot be resolved statically'],
    ["readdirSync(join(__dirname, '../../../../../..'));", 'cannot be resolved statically'],
    ['const x = `${readdirSync(dir).length}`;', 'inside a template expression'],
    ['opendirSync();', 'without a directory'],
    [
      'function f(d) { return readdirSync(d); }\nf(dirOf(x));',
      'in f() on a directory that cannot be resolved statically',
    ],
  ];
  for (const [text, reason] of cases) {
    const r = listed('test/spec/a/x.test.ts', text);
    expect(r.unresolved, text).toContain(reason);
  }
  // A recursive call stays in the tree: the parameter itself, join(param, …), a local const of it.
  for (const body of [
    'scan(d)',
    'scan(join(d, n))',
    'scan(path.join(d, n))',
    'const full = path.join(d, n); scan(full)',
  ]) {
    expect(
      listed(
        'test/spec/a/x.test.ts',
        `function scan(d) { for (const n of readdirSync(d)) { ${body}; } }\nscan(join(__dirname, 'data'));`,
      ),
      body,
    ).toEqual({ dirs: ['test/spec/a/data'], unresolved: null });
  }
  // Codex review r2, S2: a parameter shadows a same-named constant; the call site decides.
  expect(
    listed(
      'test/spec/a/x.test.ts',
      "const dir = join(__dirname, 'unused');\nfunction load(dir) { return readdirSync(dir); }\nload(join(__dirname, 'data'));",
    ),
  ).toEqual({ dirs: ['test/spec/a/data'], unresolved: null });
  // … and a call site inside another function whose parameter shadows the constant is unresolved.
  expect(
    listed(
      'test/spec/a/x.test.ts',
      "const dir = join(__dirname, 'unused');\nfunction load(d) { return readdirSync(d); }\nfunction outer(dir) { return load(dir); }",
    ).unresolved,
  ).toContain('cannot be resolved statically');
  // The repository root: `new URL('../../../', import.meta.url)` from test/spec/a resolves to ''.
  expect(
    listed(
      'test/spec/a/x.test.ts',
      "readdirSync(new URL('../../../', import.meta.url), { recursive: true });",
    ),
  ).toEqual({ dirs: [''], unresolved: null });
  // A resolved call next to an unresolved one: the resolved directory is kept, the reason too.
  const mixed = listed(
    'test/spec/a/x.test.ts',
    "readdirSync(join(__dirname, 'data')); readdirSync(somewhere);",
  );
  expect(mixed.dirs).toEqual(['test/spec/a/data']);
  expect(mixed.unresolved).toContain('cannot be resolved statically');
  // No listing at all.
  expect(listed('test/spec/a/x.test.ts', "it('x', () => {});")).toEqual({
    dirs: [],
    unresolved: null,
  });
});

it('[CT-06r] mayReadSupport: a listed directory counts only for the files it holds; an unresolved listing counts for everything', () => {
  const file = 'test/spec/l/rules.test.ts';
  const lists = mod(
    file,
    "const D = join(__dirname, 'data');\nfor (const f of readdirSync(D)) load(f);",
  );
  expect(lists.lists).toEqual(['test/spec/l/data']);
  expect(mayReadSupport(file, 'test/spec/l/data/rows.csv', [lists])).toBe(
    `${file} lists test/spec/l/data, which holds test/spec/l/data/rows.csv`,
  );
  expect(mayReadSupport(file, 'test/spec/l/data/deep/rows.csv', [lists])).toContain(
    'lists test/spec/l/data',
  );
  expect(mayReadSupport(file, 'test/spec/l/other.csv', [lists])).toBeNull();
  expect(mayReadSupport(file, 'test/spec/l/rows.csv', [lists])).toBeNull();
  // The word rule of CT-06p is untouched: a support file named like a literal still counts.
  expect(mayReadSupport(file, 'test/spec/l/data.csv', [lists])).toContain('names data');
  // Codex review r2, S2: a listing of the repository root ('') holds every file.
  const root = mod(
    file,
    "for (const f of readdirSync(new URL('../../../', import.meta.url), { recursive: true })) load(f);",
  );
  expect(root.lists).toEqual(['']);
  expect(mayReadSupport(file, 'test/spec/m/other.csv', [root])).toBe(
    `${file} lists , which holds test/spec/m/other.csv`,
  );
  const vague = mod(file, 'for (const f of readdirSync(here)) load(f);');
  expect(mayReadSupport(file, 'test/spec/m/other.csv', [vague])).toBe(
    `${file} may read test/spec/m/other.csv: it uses readdirSync(…) on a directory that cannot be resolved statically`,
  );
});

it('[CT-06r] the two B1-12g files: a same-named test elsewhere and a listing of apps/api/src no longer make them whole', () => {
  const read = (p: string): string => readFileSync(join(FIXTURES, `b112g-${p}.txt`), 'utf8');
  const files: Record<string, string> = {
    'test/spec/platform/events/contract.test.ts': read('events-contract.test.ts'),
    'test/spec/platform/queue/contract.test.ts': read('queue-contract.test.ts'),
    'test/spec/platform/events/kit.ts': read('events-kit.ts'),
    'test/spec/platform/queue/kit.ts': read('queue-kit.ts'),
    'test/spec/platform/db/kit.ts': read('db-kit.ts'),
  };
  const closureOf = (file: string) =>
    relativeClosure(
      file,
      (p) => files[p] ?? null,
      (p) => p.startsWith('test/'),
    );
  // What B1-12g changed inside its test_paths besides each file itself.
  const supports = [
    'test/spec/platform/events/contract.test.ts',
    'test/spec/platform/queue/contract.test.ts',
    ...[
      'consumer.int.test.ts',
      'db-kit.ts',
      'delivery.int.test.ts',
      'fixtures.ts',
      'render.test.ts',
      'templates.int.test.ts',
      'wiring.test.ts',
      'worker-kit.ts',
    ].map((n) => `test/spec/notification/risk-state-message/${n}`),
  ];
  const events = 'test/spec/platform/events/contract.test.ts';
  const queue = 'test/spec/platform/queue/contract.test.ts';
  const eventsClosure = closureOf(events);
  const queueClosure = closureOf(queue);
  expect(eventsClosure.map((m) => m.path)).toEqual([
    events,
    'test/spec/platform/events/kit.ts',
    'test/spec/platform/queue/kit.ts',
  ]);
  expect(queueClosure.map((m) => m.path)).toEqual([
    queue,
    'test/spec/platform/db/kit.ts',
    'test/spec/platform/queue/kit.ts',
  ]);
  // ① events/contract.test.ts: queue/contract.test.ts is another test, not its snapshot.
  for (const s of supports) {
    if (s !== events) expect(mayReadSupport(events, s, eventsClosure), s).toBeNull();
  }
  // ② queue/contract.test.ts lists apps/api/src and its queue module only.
  expect(queueClosure[0]?.lists).toEqual(['apps/api/src', 'apps/api/src/modules/platform/queue']);
  expect(queueClosure[0]?.dynamic).toBeNull();
  for (const s of supports) {
    if (s !== queue) expect(mayReadSupport(queue, s, queueClosure), s).toBeNull();
  }
  // A file under the listed tree would still count.
  expect(
    mayReadSupport(queue, 'apps/api/src/modules/platform/queue/zz-added.ts', queueClosure),
  ).toBe(
    `${queue} lists apps/api/src, which holds apps/api/src/modules/platform/queue/zz-added.ts`,
  );
});

// CT-06w (B1-12g red/4): the two platform contract tests import `./kit.ts` of their own
// directory; the task changed test/spec/identity/step-up-verify/kit.ts. The name rule matched
// the basename `kit.ts` and judged 27 unchanged tests whole.
const B112G_R4_FILES = (): Record<string, string> => {
  const read = (p: string): string => readFileSync(join(FIXTURES, `b112g-${p}.txt`), 'utf8');
  return {
    // The implementation modules the fixtures import (outside the test code: not followed).
    ...Object.fromEntries(B112G_IMPL.map((p) => [p, ''])),
    'test/spec/platform/events/contract.test.ts': read('events-contract.test.ts'),
    'test/spec/platform/queue/contract.test.ts': read('queue-contract.test.ts'),
    'test/spec/platform/events/kit.ts': read('events-kit.ts'),
    'test/spec/platform/queue/kit.ts': read('queue-kit.ts'),
    'test/spec/platform/db/kit.ts': read('db-kit.ts'),
    'test/spec/identity/step-up-verify/kit.ts': read('identity-step-up-verify-kit.ts'),
  };
};
const B112G_IMPL = [
  'events/index.ts',
  'logging/redaction.ts',
  'logging/logger.ts',
  'queue/index.ts',
  'db/index.ts',
  'config/index.ts',
].map((p) => `apps/api/src/modules/platform/${p}`);
/** What B1-12g changed inside its test_paths at red/4 (couli-runs/B1-12g/red/4). */
const B112G_R4_SUPPORTS = [
  'test/spec/platform/events/contract.test.ts',
  'test/spec/platform/queue/contract.test.ts',
  'test/spec/platform/idempotency/abandon-route/http-kit.ts',
  'test/spec/identity/identity-level/http-kit.ts',
  'test/spec/identity/sms-codes/http-kit.ts',
  'test/spec/identity/step-up-verify/kit.ts',
  ...[
    'consumer.int.test.ts',
    'db-kit.ts',
    'delivery.int.test.ts',
    'fixtures.ts',
    'reauth.int.test.ts',
    'render.test.ts',
    'templates.int.test.ts',
    'wiring.test.ts',
    'worker-kit.ts',
  ].map((n) => `test/spec/notification/risk-state-message/${n}`),
];

it('[CT-06w] the two B1-12g files (red/4): `./kit.ts` of their own directory is not the identity kit the task changed', () => {
  const files = B112G_R4_FILES();
  const closureOf = (file: string) =>
    relativeClosure(
      file,
      (p) => files[p] ?? null,
      (p) => p.startsWith('test/'),
    );
  const events = 'test/spec/platform/events/contract.test.ts';
  const queue = 'test/spec/platform/queue/contract.test.ts';
  const eventsClosure = closureOf(events);
  const queueClosure = closureOf(queue);
  // The imports resolve to the files of their own directories; a package stays unresolved.
  const resolved = (c: readonly Module[]) =>
    Object.fromEntries((c[0] as Module).imports.map((i) => [i.spec, i.resolved]));
  expect(resolved(eventsClosure)).toMatchObject({
    './kit.ts': 'test/spec/platform/events/kit.ts',
    '../queue/kit.ts': 'test/spec/platform/queue/kit.ts',
    vitest: null,
  });
  expect(resolved(queueClosure)).toMatchObject({
    './kit.ts': 'test/spec/platform/queue/kit.ts',
    '../db/kit.ts': 'test/spec/platform/db/kit.ts',
  });
  expect((eventsClosure[0] as Module).imports.find((i) => i.spec === 'vitest')?.why).toBe(
    'a package (a bare specifier; tsconfig paths are not used by Vitest here)',
  );
  // The identity kit is in neither closure.
  expect(eventsClosure.map((m) => m.path)).toEqual([
    events,
    'test/spec/platform/events/kit.ts',
    'test/spec/platform/queue/kit.ts',
  ]);
  expect(queueClosure.map((m) => m.path)).toEqual([
    queue,
    'test/spec/platform/db/kit.ts',
    'test/spec/platform/queue/kit.ts',
  ]);
  // The kits are closed (no file-system access, import.meta, mock, listing or unread import).
  for (const m of [...eventsClosure.slice(1), ...queueClosure.slice(1)]) {
    expect([m.path, m.closed, m.opaque]).toEqual([m.path, true, null]);
  }
  // The 27 unchanged tests of red/4: neither file may read any changed support file.
  for (const s of B112G_R4_SUPPORTS) {
    if (s !== events) expect(mayReadSupport(events, s, eventsClosure), s).toBeNull();
    if (s !== queue) expect(mayReadSupport(queue, s, queueClosure), s).toBeNull();
  }
});

it('[CT-06w] the same `./kit.ts` that the task did change still makes the file whole', () => {
  const files = B112G_R4_FILES();
  const events = 'test/spec/platform/events/contract.test.ts';
  const closure = relativeClosure(
    events,
    (p) => files[p] ?? null,
    (p) => p.startsWith('test/'),
  );
  expect(mayReadSupport(events, 'test/spec/platform/events/kit.ts', closure)).toBe(
    'it loads test/spec/platform/events/kit.ts',
  );
  expect(mayReadSupport(events, 'test/spec/platform/queue/kit.ts', closure)).toBe(
    'it loads test/spec/platform/queue/kit.ts',
  );
  // A support file the closure does not follow (data) counts through the resolved import.
  const file = 'test/spec/l/rules.test.ts';
  const rows: Record<string, string> = {
    [file]: "import rows from './rows.json';",
    'test/spec/l/rows.json': '[]',
  };
  const data = relativeClosure(
    file,
    (p) => rows[p] ?? null,
    (p) => p.startsWith('test/'),
  );
  expect(mayReadSupport(file, 'test/spec/l/rows.json', data)).toBe(
    `${file} imports test/spec/l/rows.json (./rows.json)`,
  );
  // A code file that `follow` keeps out of the closure counts the same way.
  const kept = relativeClosure(
    file,
    (p) => ({ [file]: "import { k } from './kit.ts';", 'test/spec/l/kit.ts': '' })[p] ?? null,
    () => false,
  );
  expect(kept.map((m) => m.path)).toEqual([file]);
  expect(mayReadSupport(file, 'test/spec/l/kit.ts', kept)).toBe(
    `${file} imports test/spec/l/kit.ts (./kit.ts)`,
  );
});

it('[CT-06w] an import that cannot be resolved keeps the name rules, and the reason says so', () => {
  const file = 'test/spec/l/rules.test.ts';
  const support = 'test/spec/identity/step-up-verify/kit.ts';
  // A package whose specifier carries the name: not a repository file, so it counts as before.
  const pkg = mod(file, "import { k } from 'fixtures-pkg/kit.ts';");
  expect(mayReadSupport(file, support, [pkg])).toBe(
    `${file} names kit.ts in an unresolved import fixtures-pkg/kit.ts (a package (a bare specifier; tsconfig paths are not used by Vitest here))`,
  );
  // A relative import of a file that does not exist at the head.
  const gone = mod(file, "import { k } from './kit.ts';");
  expect((gone.imports[0] as ModuleImport).resolved).toBeNull();
  expect(mayReadSupport(file, support, [gone])).toBe(
    `${file} names kit.ts in an unresolved import ./kit.ts (no file at test/spec/l/kit.ts)`,
  );
  // The word rule the same way (an extension-less specifier).
  const word = mod(file, "import { k } from 'fixtures-pkg/kit';");
  expect(mayReadSupport(file, support, [word])).toBe(
    `${file} names kit in an unresolved import fixtures-pkg/kit (a package (a bare specifier; tsconfig paths are not used by Vitest here))`,
  );
  // One that leaves the repository.
  const out = mod('test/x.test.ts', "import { k } from '../../kit.ts';");
  expect(mayReadSupport('test/x.test.ts', support, [out])).toBe(
    `test/x.test.ts names kit.ts in an unresolved import ../../kit.ts (it leaves the repository)`,
  );
  // A template specifier, vi.mock and new URL are not imports: the name rules apply unchanged.
  const files: Record<string, string> = { 'test/spec/l/kit.ts': '' };
  const other = (text: string) =>
    relativeClosure(
      file,
      (p) => (p === file ? text : (files[p] ?? null)),
      (p) => p.startsWith('test/'),
    );
  expect(mayReadSupport(file, support, other('const m = await import(`./kit.ts`);'))).toBe(
    `${file} names kit.ts`,
  );
  expect(mayReadSupport(file, support, other("vi.mock('./kit.ts', () => ({}));"))).toBe(
    `${file} names kit.ts`,
  );
  expect(mayReadSupport(file, support, other("new URL('./kit.ts', import.meta.url);"))).toBe(
    `${file} names kit.ts`,
  );
  // The name elsewhere in the file (a comment, another literal) still counts even when the
  // import of the same name resolves to another file.
  expect(
    mayReadSupport(file, support, other("import { k } from './kit.ts'; // see kit.ts of identity")),
  ).toBe(`${file} names kit.ts`);
  expect(
    mayReadSupport(file, support, other("import { k } from './kit.ts';\nload('../identity/kit');")),
  ).toBe(`${file} names kit`);
  // Resolved to another file, nothing else names it: not this support file.
  expect(mayReadSupport(file, support, other("import { k } from './kit.ts';"))).toBeNull();
  expect(mayReadSupport(file, support, other("import { k } from './kit';"))).toBeNull();
  expect(mayReadSupport(file, support, other("export * from './kit.js';"))).toBeNull();
  expect(mayReadSupport(file, support, other("const k = await import('./kit.ts');"))).toBeNull();
  expect(mayReadSupport(file, support, other("import './kit.ts?raw';"))).toBeNull();
});

it('[CT-06w] `#…` imports resolve through the nearest package.json where one entry is certain; a bare specifier is a package', () => {
  const file = 'test/spec/l/rules.test.ts';
  const support = 'test/spec/identity/step-up-verify/kit.ts';
  const base: Record<string, string> = {
    'test/kits/kit.ts': '',
    'test/kits/data/kit.ts': '',
    'test/other/kit.ts': '',
    'test/support/kit.ts': '',
    'test/package.json': JSON.stringify({
      imports: {
        '#kits/*': './kits/*.ts',
        '#one': './kits/kit.ts',
        '#cond': { default: './kits/kit.ts' },
        '#pkg': 'some-package',
        '#up': '../tsconfig.json',
        // Codex reviews r1, r2: Node and Vite's resolver rank two matching patterns differently
        // (longest prefix vs longest key): not decided here.
        '#same/*': './other/kit.ts',
        '#same/*.ts': './support/kit.ts',
        '#folder/': './other/',
        // Codex review r1: only the first `#` belongs to the specifier, the rest is a fragment.
        '#kit.ts': './support/kit.ts',
        '#kit.ts#preview': './other/kit.ts',
      },
    }),
    // tsconfig paths are not consulted (Vitest does not enable them here).
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@kits/*': ['test/kits/*'] } },
    }),
  };
  const closure = (text: string, files = base) =>
    relativeClosure(
      file,
      (p) => (p === file ? text : (files[p] ?? null)),
      (p) => p.startsWith('test/'),
    );
  const imports = (text: string, files = base) =>
    (closure(text, files)[0] as Module).imports.map((i) => [i.spec, i.resolved, i.why]);
  expect(
    imports(
      [
        "import { a } from '#kits/kit';",
        "import { b } from '#one';",
        "import { c } from '#cond';",
        "import { d } from '#none';",
        "import { e } from '#pkg';",
        "import { f } from '#same/kit.ts';",
        "import { g } from '#kit.ts#preview';",
        "import { h } from '#one?raw';",
        "import { i } from '#folder/kit.ts';",
        "import { j } from '#up';",
        "import { k } from '#kits/';",
      ].join('\n'),
    ),
  ).toEqual([
    ['#kits/kit', 'test/kits/kit.ts', null],
    ['#one', 'test/kits/kit.ts', null],
    ['#cond', null, 'test/package.json imports #cond is conditional'],
    ['#none', null, 'test/package.json maps no imports entry to #none'],
    ['#pkg', null, 'test/package.json imports #pkg is not a plain ./ path'],
    ['#same/kit.ts', null, 'test/package.json cannot decide the imports entry for #same/kit.ts'],
    ['#kit.ts#preview', 'test/support/kit.ts', null],
    ['#one?raw', 'test/kits/kit.ts', null],
    [
      '#folder/kit.ts',
      null,
      'test/package.json cannot decide the imports entry for #folder/kit.ts',
    ],
    ['#up', null, 'test/package.json imports #up is not a plain ./ path'],
    ['#kits/', null, 'test/package.json cannot decide the imports entry for #kits/'],
  ]);
  // `#same/kit.ts` is undecided and names the support file: whole; `#kit.ts#preview` loads it.
  expect(
    mayReadSupport(file, 'test/support/kit.ts', closure("import { f } from '#same/kit.ts';")),
  ).toBe(
    `${file} names kit.ts in an unresolved import #same/kit.ts (test/package.json cannot decide the imports entry for #same/kit.ts)`,
  );
  expect(
    mayReadSupport(file, 'test/support/kit.ts', closure("import { g } from '#kit.ts#preview';")),
  ).toBe('it loads test/support/kit.ts');
  expect(imports("import { a } from '@kits/kit';\nimport { b } from 'vitest';")).toEqual([
    ['@kits/kit', null, 'a package (a bare specifier; tsconfig paths are not used by Vitest here)'],
    ['vitest', null, 'a package (a bare specifier; tsconfig paths are not used by Vitest here)'],
  ]);
  expect(mayReadSupport(file, support, closure("import { a } from '@kits/kit';"))).toBe(
    `${file} names kit in an unresolved import @kits/kit (a package (a bare specifier; tsconfig paths are not used by Vitest here))`,
  );
  // Resolved elsewhere: not the identity kit; a resolved `#` import is followed.
  const c = closure("import { a } from '#kits/kit';\nimport { b } from '#kits/data/kit';");
  expect(c.map((m) => m.path)).toEqual([file, 'test/kits/kit.ts', 'test/kits/data/kit.ts']);
  expect(mayReadSupport(file, support, c)).toBeNull();
  expect(mayReadSupport(file, 'test/kits/kit.ts', c)).toBe('it loads test/kits/kit.ts');
  // A package.json that cannot be parsed: unresolved, conservative.
  const broken = { ...base, 'test/package.json': '{ imports: }' };
  expect(imports("import { a } from '#one';", broken)).toEqual([
    ['#one', null, 'test/package.json cannot be parsed'],
  ]);
  expect(mayReadSupport(file, support, closure("import { a } from '#kit.ts';", broken))).toBe(
    `${file} names kit.ts in an unresolved import #kit.ts (test/package.json cannot be parsed)`,
  );
  // Codex review r2: a nearer package.json that is not a regular file (a symbolic link) stops the
  // search — the runtime would read it, the gate cannot.
  const linked: Record<string, string> = {
    ...base,
    'test/spec/l/package.json': '../../../config/imports.json',
  };
  const kinds = (p: string): PathKind =>
    p === 'test/spec/l/package.json' ? 'other' : linked[p] === undefined ? 'absent' : 'file';
  const viaLink = relativeClosure(
    file,
    (p) => (p === file ? "import { a } from '#kit.ts';" : (linked[p] ?? null)),
    (p) => p.startsWith('test/'),
    kinds,
  );
  expect((viaLink[0] as Module).imports[0]?.why).toBe(
    'test/spec/l/package.json is not a regular file',
  );
  expect(mayReadSupport(file, 'test/spec/l/support/kit.ts', viaLink)).toBe(
    `${file} names kit.ts in an unresolved import #kit.ts (test/spec/l/package.json is not a regular file)`,
  );
});

it('[CT-06w] a relative import resolves only where one file is certain (Codex reviews r1, r2)', () => {
  const file = 'test/spec/a/rules.test.ts';
  const support = 'test/spec/identity/step-up-verify/kit.ts';
  const closure = (text: string, files: Record<string, string>, kindOf?: (p: string) => PathKind) =>
    relativeClosure(
      file,
      (p) => (p === file ? text : (files[p] ?? null)),
      (p) => p.startsWith('test/'),
      kindOf,
    );
  const why = (text: string, files: Record<string, string>, kindOf?: (p: string) => PathKind) =>
    (closure(text, files, kindOf)[0] as Module).imports.map((i) => i.resolved ?? i.why);
  /** An in-memory tree with directories and `other` paths (symbolic links) marked. */
  const tree = (files: Record<string, string>, dirs: string[] = [], others: string[] = []) => {
    const kindOf = (p: string): PathKind =>
      others.includes(p)
        ? 'other'
        : dirs.includes(p)
          ? 'dir'
          : files[p] === undefined
            ? 'absent'
            : 'file';
    return { files, kindOf };
  };
  // `./kit` with both kit.js and kit.ts: Vite picks one by its extension order; not certain here.
  expect(
    why("import { k } from './kit';", { 'test/spec/a/kit.js': '', 'test/spec/a/kit.ts': '' }),
  ).toEqual(['test/spec/a/kit is ambiguous (test/spec/a/kit.js, test/spec/a/kit.ts)']);
  // `./kit` with only kit.ts: that file; a directory with only index.ts: that file; both: ambiguous.
  expect(why("import { k } from './kit';", { 'test/spec/a/kit.ts': '' })).toEqual([
    'test/spec/a/kit.ts',
  ]);
  const dirIndex = tree({ 'test/spec/a/kit/index.ts': '' }, ['test/spec/a/kit']);
  expect(why("import { k } from './kit';", dirIndex.files, dirIndex.kindOf)).toEqual([
    'test/spec/a/kit/index.ts',
  ]);
  const both = tree({ 'test/spec/a/kit.ts': '', 'test/spec/a/kit/index.ts': '' }, [
    'test/spec/a/kit',
  ]);
  expect(why("import { k } from './kit';", both.files, both.kindOf)).toEqual([
    'test/spec/a/kit is ambiguous (test/spec/a/kit.ts, test/spec/a/kit/index.ts)',
  ]);
  // Without kinds, a directory is unknown to the in-memory tree: its index is not found.
  expect(why("import { k } from './kit';", { 'test/spec/a/kit/index.ts': '' })).toEqual([
    'no file at test/spec/a/kit',
  ]);
  // A directory with a package.json: its entry decides, not resolved here.
  const pkgDir = tree(
    { 'test/spec/a/kit/package.json': '{"main":"./kit.ts"}', 'test/spec/a/kit/index.ts': '' },
    ['test/spec/a/kit'],
  );
  expect(why("import { k } from './kit';", pkgDir.files, pkgDir.kindOf)).toEqual([
    'test/spec/a/kit is a package directory (test/spec/a/kit/package.json)',
  ]);
  // Codex review r2: `./kit?raw` with a file called `kit` next to kit.ts loads `kit` itself.
  expect(
    why("import raw from './kit?raw';", { 'test/spec/a/kit': 'rows', 'test/spec/a/kit.ts': '' }),
  ).toEqual(['test/spec/a/kit']);
  expect(
    mayReadSupport(
      file,
      'test/spec/a/kit',
      closure("import raw from './kit?raw';", {
        'test/spec/a/kit': 'rows',
        'test/spec/a/kit.ts': '',
      }),
    ),
  ).toBe(`${file} imports test/spec/a/kit (./kit?raw)`);
  // `./kit.js`: the .js file when it exists, else the .ts file; `./kit.jsx` is not rewritten.
  expect(
    why("import { k } from './kit.js';", { 'test/spec/a/kit.js': '', 'test/spec/a/kit.ts': '' }),
  ).toEqual(['test/spec/a/kit.js']);
  expect(why("import { k } from './kit.js';", { 'test/spec/a/kit.ts': '' })).toEqual([
    'test/spec/a/kit.ts',
  ]);
  expect(why("import { k } from './kit.jsx';", { 'test/spec/a/kit.tsx': '' })).toEqual([
    'no file at test/spec/a/kit.jsx',
  ]);
  // In each uncertain case the name rules apply as before.
  expect(
    mayReadSupport(
      file,
      support,
      closure("import { k } from './kit';", {
        'test/spec/a/kit.js': '',
        'test/spec/a/kit.ts': '',
      }),
    ),
  ).toBe(
    `${file} names kit in an unresolved import ./kit (test/spec/a/kit is ambiguous (test/spec/a/kit.js, test/spec/a/kit.ts))`,
  );
  // Codex reviews r1, r2: a path that is a directory or `other` (a symbolic link, a path whose
  // spelling is not the tree's) is no file, and a candidate of kind `other` on the way makes the
  // whole resolution uncertain — a rejected candidate is not an absent one.
  const links = tree(
    {
      'test/spec/a/kit.json/data/kit.json': '{}',
      'test/spec/a/link.ts': '../real/kit.ts',
      'test/spec/a/kit.js': '../real/kit.js',
      'test/spec/a/kit.ts': '',
      'test/spec/real/kit.ts': '',
      'test/spec/real/kit.js': '',
    },
    ['test/spec/a/kit.json'],
    ['test/spec/a/link.ts', 'test/spec/a/kit.js', 'test/spec/a/alias/kit.json'],
  );
  expect(why("import data from './kit.json';", links.files, links.kindOf)).toEqual([
    'test/spec/a/kit.json is a directory',
  ]);
  expect(
    mayReadSupport(
      file,
      'test/spec/a/kit.json/data/kit.json',
      closure("import data from './kit.json';", links.files, links.kindOf),
    ),
  ).toBe(
    `${file} names kit.json in an unresolved import ./kit.json (test/spec/a/kit.json is a directory)`,
  );
  expect(why("import { k } from './link.ts';", links.files, links.kindOf)).toEqual([
    'test/spec/a/link.ts is not a regular file',
  ]);
  expect(
    mayReadSupport(
      file,
      'test/spec/real/kit.ts',
      closure("import { k } from './link.ts';", links.files, links.kindOf),
    ),
  ).toBe('test/spec/a/link.ts names kit.ts'); // the closure still follows the link's own text
  // `./kit` where kit.js is a link and kit.ts a file: Vite would follow the link; not decided.
  expect(why("import { k } from './kit';", links.files, links.kindOf)).toEqual([
    'test/spec/a/kit.js is not a regular file',
  ]);
  expect(
    mayReadSupport(
      file,
      'test/spec/real/kit.js',
      closure("import { k } from './kit';", links.files, links.kindOf),
    ),
  ).toBe(
    `${file} names kit in an unresolved import ./kit (test/spec/a/kit.js is not a regular file)`,
  );
  // A path through a directory link (a work tree spelling that is not the tree's).
  expect(why("import data from './alias/kit.json';", links.files, links.kindOf)).toEqual([
    'test/spec/a/alias/kit.json is not a regular file',
  ]);
  // Without kinds the in-memory tree is all files (the tests above).
  expect(why("import data from './kit.json';", links.files)).toEqual([
    'no file at test/spec/a/kit.json',
  ]);
});

it('[CT-06w] only the import and export syntax makes a string an import specifier (Codex reviews r1, r2)', () => {
  const file = 'test/spec/a/rules.test.ts';
  const files: Record<string, string> = {
    'test/spec/a/data/rows.json': '[]',
    'test/spec/a/kit.ts': '',
  };
  const closure = (text: string) =>
    relativeClosure(
      file,
      (p) => (p === file ? text : (files[p] ?? null)),
      (p) => p.startsWith('test/'),
    );
  const specs = (text: string) => (closure(text)[0] as Module).imports.map((i) => i.spec);
  // Imports and re-exports in every spelling.
  expect(
    specs(
      [
        "import './kit.ts';",
        "import k from './kit.ts';",
        "import * as ns from './kit.ts';",
        "import k2, { a } from './kit.ts';",
        "import type { T } from './kit.ts';",
        "export * from './kit.ts';",
        "export * as all from './kit.ts';",
        "export { a } from './kit.ts';",
        "const m = await import('./kit.ts');",
        "import('./data/rows.json', { with: { type: 'json' } });",
      ].join('\n'),
    ),
  ).toEqual([...Array<string>(9).fill('./kit.ts'), './data/rows.json']);
  // Not imports: member calls, object keys, a string after a `from` variable, template expressions.
  expect(
    specs("const reader = { import: (p: string) => p };\nreader.import('./data/rows.json');"),
  ).toEqual([]);
  expect(specs("reader?.import('./data/rows.json');")).toEqual([]);
  expect(specs("x.from('./data/rows.json');")).toEqual([]);
  expect(specs("const q = { from: './data/rows.json' };")).toEqual([]);
  expect(specs("const from = '';\nconst u = `${from}${'./data/rows.json'}`;")).toEqual([]);
  expect(specs("const u = `${a}${from}${'./data/rows.json'}`;")).toEqual([]);
  expect(specs("const m = `${await import('./kit.ts')}`;")).toEqual([]);
  expect(specs("import.meta.resolve('./kit.ts');")).toEqual([]);
  expect(specs("vi.importActual('./kit.ts');")).toEqual([]);
  // The task changed test/data/rows.json: the member call and the template read it by a computed
  // path; nothing is masked, the name rule still fires (Codex reviews r1, r2).
  expect(
    mayReadSupport(
      file,
      'test/data/rows.json',
      closure(
        "const reader = { import: (p: string) => readFileSync(new URL(p, new URL('../../', import.meta.url)), 'utf8') };\nreader.import('./data/rows.json');",
      ),
    ),
  ).toBe(`${file} names rows.json`);
  expect(
    mayReadSupport(
      file,
      'test/data/rows.json',
      closure(
        "const from = '';\nreadFileSync(new URL(`${from}${'./data/rows.json'}`, new URL('../../', import.meta.url)), 'utf8');",
      ),
    ),
  ).toBe(`${file} names rows.json`);
});

it('[CT-06w] `#…` entries the runtime may expand differently stay unresolved (Codex review r3)', () => {
  const file = 'test/spec/l/rules.test.ts';
  const files: Record<string, string> = {
    'test/other/kit.ts': '',
    'test/other/index.ts': '',
    'test/support/kit.ts': '',
    'test/data/kit.json': '{}',
    'test/package.json': JSON.stringify({
      imports: {
        // Vite's resolver builds an unescaped RegExp from a pattern: `#k.t.*` matches `#kit.ts`.
        '#kit.*': './other/kit.ts',
        '#k.t.*': './support/kit.ts',
        // A folder value: the resolver appends the rest; a literal `*` in an exact entry's value.
        '#kits/*': './other/',
        '#star': './other/*/kit.ts',
        // A query the loader strips.
        '#kit.json': './data/kit.json?raw',
        // Plain entries resolve.
        '#plain/*': './support/*.ts',
        '#exact': './support/kit.ts',
      },
    }),
  };
  const imports = (text: string) =>
    (
      relativeClosure(
        file,
        (p) => (p === file ? text : (files[p] ?? null)),
        (p) => p.startsWith('test/'),
      )[0] as Module
    ).imports.map((i) => [i.spec, i.resolved, i.why]);
  expect(
    imports(
      [
        "import { a } from '#kit.ts';",
        "import { b } from '#kits/kit.ts';",
        "import { c } from '#star';",
        "import { d } from '#kit.json';",
        "import { e } from '#plain/kit';",
        "import { f } from '#exact';",
      ].join('\n'),
    ),
  ).toEqual([
    ['#kit.ts', null, 'test/package.json cannot decide the imports entry for #kit.ts'],
    ['#kits/kit.ts', null, 'test/package.json cannot decide the imports entry for #kits/kit.ts'],
    ['#star', null, 'test/package.json imports #star is not a plain ./ path'],
    ['#kit.json', null, 'test/package.json cannot decide the imports entry for #kit.json'],
    ['#plain/kit', 'test/support/kit.ts', null],
    ['#exact', 'test/support/kit.ts', null],
  ]);
});

it('[CT-06w] an import resolved to a file the closure does not follow keeps the name rules (Codex review r3)', () => {
  const file = 'test/spec/a/rules.browser.test.ts';
  const files: Record<string, string> = {
    'test/spec/a/theme.css': "@import '../real/theme.css';",
    'test/spec/a/kit': "export * from '../real/kit.ts';",
    'test/spec/a/rows.json': '[]',
    'test/spec/real/theme.css': '',
    'test/spec/real/kit.ts': '',
    'apps/api/src/x.ts': '',
  };
  const closure = (text: string) =>
    relativeClosure(
      file,
      (p) => (p === file ? text : (files[p] ?? null)),
      (p) => p.startsWith('test/'),
    );
  // A style sheet (its @import is not read here), an extension-less module (not code to the
  // closure), a data file, a module outside the test code: resolved, not followed, still named.
  const css = closure("import './theme.css';");
  expect((css[0] as Module).imports[0]?.resolved).toBe('test/spec/a/theme.css');
  expect(css.map((m) => m.path)).toEqual([file]);
  expect(mayReadSupport(file, 'test/spec/real/theme.css', css)).toBe(
    `${file} names theme.css in an unresolved import ./theme.css (test/spec/a/theme.css is not followed by the closure)`,
  );
  expect(mayReadSupport(file, 'test/spec/real/kit.ts', closure("import { k } from './kit';"))).toBe(
    `${file} names kit in an unresolved import ./kit (test/spec/a/kit is not followed by the closure)`,
  );
  expect(
    mayReadSupport(file, 'test/other/rows.json', closure("import rows from './rows.json';")),
  ).toBe(
    `${file} names rows.json in an unresolved import ./rows.json (test/spec/a/rows.json is not followed by the closure)`,
  );
  expect(
    mayReadSupport(
      file,
      'test/spec/real/x.ts',
      closure("import { x } from '../../../apps/api/src/x.ts';"),
    ),
  ).toBe(
    `${file} names x.ts in an unresolved import ../../../apps/api/src/x.ts (apps/api/src/x.ts is not followed by the closure)`,
  );
  // The resolved file itself as the support file still counts by its path.
  expect(mayReadSupport(file, 'test/spec/a/theme.css', css)).toBe(
    `${file} imports test/spec/a/theme.css (./theme.css)`,
  );
});

it('[CT-06w] only an import of a closed module is skipped by the name rules (Codex review r4)', () => {
  const file = 'test/spec/a/rules.test.ts';
  const support = 'test/spec/real/kit.ts';
  const files: Record<string, string> = {
    'test/spec/a/bridge': "export { n } from '../real/kit.ts';",
    'test/spec/a/__mocks__/kit.ts': '',
    'test/spec/a/payload.txt': 'rows',
    'apps/api/src/x.ts': '',
    'test/spec/a/plain.ts': "import { x } from '../../../apps/api/src/x.ts';\nexport const n = x;",
    'test/spec/a/chain.ts': "export { n } from './plain.ts';",
    'test/spec/real/kit.ts': '',
  };
  const closure = (text: string, kit: string) =>
    relativeClosure(
      file,
      (p) => (p === file ? text : p === 'test/spec/a/kit.ts' ? kit : (files[p] ?? null)),
      (p) => p.startsWith('test/'),
    );
  const root = "import { n } from './kit.ts';";
  const why = (kit: string) => mayReadSupport(file, support, closure(root, kit));
  const prefix = `${file} names kit.ts in an unresolved import ./kit.ts (test/spec/a/kit.ts is not closed: `;
  // A helper that reads a file by a path built from import.meta.url, with no name literal.
  expect(
    why(
      "import { readFileSync } from 'node:fs';\nexport const n = readFileSync(new URL(import.meta.url.replace('/a/', '/real/')), 'utf8');",
    ),
  ).toBe(`${prefix}it uses readFileSync)`);
  expect(why('export const n = import.meta.url;')).toBe(`${prefix}it uses import.meta)`);
  expect(why("import fs from 'fs';\nexport const n = fs;")).toBe(`${prefix}it uses fs)`);
  expect(why("import { vi } from 'vitest';\nvi.mock('./x.ts');\nexport const n = 1;")).toBe(
    `${prefix}it uses vi.mock)`,
  );
  // A listing (its directory resolved or not) and a dynamic load.
  expect(
    why(
      "import { readdirSync } from 'node:fs';\nexport const n = readdirSync(new URL('../d%61ta/', import.meta.url));",
    ),
  ).toBe(`${prefix}it lists test/spec/d%61ta)`);
  expect(why("export const n = await import(`./${'x'}.ts`);")).toBe(
    `${prefix}it imports a module by a computed name)`,
  );
  // A two-step re-export through an extension-less module the closure does not read.
  expect(why("export { n } from './bridge';")).toBe(
    `${prefix}it imports test/spec/a/bridge, which is not read here)`,
  );
  expect(why("export { n } from './gone.ts';")).toBe(
    `${prefix}it imports ./gone.ts, which cannot be resolved)`,
  );
  // A raw import of a file not read here.
  expect(why("import raw from './payload.txt?raw';\nexport const n = raw;")).toBe(
    `${prefix}it imports test/spec/a/payload.txt, which is not read here)`,
  );
  // Closed: a plain module, a chain of plain modules, implementation and package imports.
  expect(why('export const n = 1;')).toBeNull();
  expect(why("export { n } from './chain.ts';")).toBeNull();
  expect(
    why(
      "import { it } from 'vitest';\nimport { x } from '../../../apps/api/src/x.ts';\nexport const n = [it, x];",
    ),
  ).toBeNull();
  // The closure records why a module is not closed, transitively.
  const c = closure(root, "export { n } from './bridge';");
  expect(c.map((m) => [m.path, m.closed, m.opaque])).toEqual([
    [file, false, 'it imports test/spec/a/kit.ts, which is not closed'],
    ['test/spec/a/kit.ts', false, 'it imports test/spec/a/bridge, which is not read here'],
  ]);
  // `vi.mock(import('./kit.ts'))` is a mock, not a load: the specifier keeps the name rules.
  expect(
    mayReadSupport(
      file,
      'test/spec/a/__mocks__/kit.ts',
      closure(
        "import { vi } from 'vitest';\nvi.mock(import('./kit.ts'));\nimport { n } from './kit.ts';",
        'export const n = 1;',
      ),
    ),
  ).toBe(`${file} names kit.ts`);
});
