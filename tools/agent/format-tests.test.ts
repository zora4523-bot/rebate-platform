// Tests for format-tests.ts (D10-292): the normalization that decides "format-only", and the CLI
// with fake eslint / prettier executables in a fake trusted root under REPO/.tmp/ (never /tmp).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { canonNumber, formatOnly, lineStats, normalize } from './format-tests.ts';
import { AGENT_DIR, REPO, writeFakeFormatters } from './testing/fixture.ts';

const SCRIPT = join(AGENT_DIR, 'format-tests.ts');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('[D10-292] whitespace, line breaks and indentation are format-only', () => {
  expect(
    formatOnly(
      'const a = {x:1,  y:2}\nfoo( a,b )',
      'const a = {\n  x: 1,\n  y: 2,\n};\nfoo(a, b);\n',
    ),
  ).toBe(true);
  expect(formatOnly('a\r\nb', 'a\nb\n')).toBe(true);
});

it('[D10-292] quote style, escaped quotes, commas, semicolons and parentheses are format-only', () => {
  expect(formatOnly(`const s = "it's", t = "a"`, `const s = "it's",\n  t = 'a';`)).toBe(true);
  expect(formatOnly(`x = 'a\\'b"c'`, `x = "a'b\\"c"`)).toBe(true);
  expect(formatOnly(`f(a, b,)`, `f(a, b)`)).toBe(true);
  expect(formatOnly(`const f = x => x;`, `const f = (x) => x`)).toBe(true);
  expect(formatOnly(`new Foo`, `new Foo();`)).toBe(true);
});

it('[D10-292] quoted keys, leading union bars and number forms compare as prettier prints them', () => {
  expect(formatOnly(`o = { 'a': 1, "b-c": 2 }`, `o = { a: 1, 'b-c': 2 };`)).toBe(true);
  expect(formatOnly(`type T = { 'a'?: string }`, `type T = { a?: string };`)).toBe(true);
  expect(formatOnly(`type U = 'a' | 'b'`, `type U =\n  | 'a'\n  | 'b';`)).toBe(true);
  expect(formatOnly(`type F = () => A | B`, `type F = () =>\n  | A\n  | B;`)).toBe(true);
  // A default value before a return type is not a key: `= 'b'` stays a string.
  expect(formatOnly(`f = (s: 'a' | 'b' = 'b'): T => s`, `f = (s: 'a' | 'b' = b): T => s`)).toBe(
    false,
  );
  expect(formatOnly(`[1.50, 0XAB, 1E+5, .5, 5., 10n]`, `[1.5, 0xab, 1e5, 0.5, 5, 10n]`)).toBe(true);
  expect(canonNumber('1.0')).toBe('1');
  expect(canonNumber('0xAB')).toBe('0xab');
  expect(canonNumber('1_000.00')).toBe('1_000');
});

it('[D10-292] comments, template text and regular expressions keep their content', () => {
  expect(formatOnly('/**\n   * doc\n   */\nx', '/**\n * doc\n */\nx;\n')).toBe(true);
  expect(formatOnly('t = `a ${ x } b`', 't = `a ${x} b`;')).toBe(true);
  expect(formatOnly('t = `a  b`', 't = `a b`')).toBe(false);
  expect(formatOnly('r = /a b/g', 'r = /ab/g')).toBe(false);
  expect(formatOnly('expect(s).toMatch(/>\\s*x/);', 'expect(s).toMatch(/>\\s*x/)')).toBe(true);
  expect(formatOnly('expect(s).toMatch(/> x/)', 'expect(s).toMatch(/>x/)')).toBe(false);
  expect(formatOnly('const a = p[0]! / 255;', 'const a = p[0]! / 255')).toBe(true);
  expect(formatOnly('// keep me', '// changed')).toBe(false);
});

it('[D10-292] a changed identifier, number or string content is not format-only', () => {
  expect(formatOnly('const a = 1;', 'const b = 1;')).toBe(false);
  expect(formatOnly('const a = 1;', 'const a = 2;')).toBe(false);
  expect(formatOnly('const a = 1.5;', 'const a = 1.05;')).toBe(false);
  expect(formatOnly("expect(x).toBe('a b')", "expect(x).toBe('ab')")).toBe(false);
  expect(formatOnly("it('one', f)", "it('two', f)")).toBe(false);
  // A string is not an identifier outside a key position.
  expect(formatOnly("x = 'a'", 'x = a')).toBe(false);
  expect(formatOnly("switch (x) { case 'a': break }", 'switch (x) { case a: break }')).toBe(false);
  expect(
    formatOnly(
      "switch (x) { case 'a': return (y)\n case 'b': }",
      "switch (x) { case 'a': return (y)\n case b: }",
    ),
  ).toBe(false);
  expect(formatOnly("y = c ? 'a' : b", 'y = c ? a : b')).toBe(false);
  expect(formatOnly('y = a || b', 'y = a | b')).toBe(false);
  expect(formatOnly('f(a, b)', 'f(ab)')).toBe(false);
  expect(formatOnly('let x = 1', 'letx = 1')).toBe(false);
  expect(formatOnly('expect(a).toBe(b)', 'expect(a).not.toBe(b)')).toBe(false);
});

it('[D10-292] the normalized form separates strings from code', () => {
  expect(normalize(`foo('a', "b")`)).toEqual([
    { k: 'code', t: 'foo' },
    { k: 'str', t: 'a' },
    { k: 'str', t: 'b' },
  ]);
});

it('[D10-292] line statistics count added and removed lines', () => {
  expect(lineStats('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({
    lines_before: 3,
    lines_after: 4,
    lines_added: 2,
    lines_removed: 1,
  });
});

type Env = { root: string; trusted: string; worktree: string; log: string };

/** A fake trusted root with fake eslint / prettier (testing/fixture.ts) and a worktree. */
function env(name: string): Env {
  const root = join(
    REPO,
    '.tmp',
    `format-tests-${name}-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  dirs.push(root);
  const trusted = join(root, 'trusted');
  const worktree = join(root, 'worktree');
  const log = join(root, 'log');
  writeFakeFormatters(trusted);
  mkdirSync(join(worktree, 'test', 'spec'), { recursive: true });
  mkdirSync(log, { recursive: true });
  return { root, trusted, worktree, log };
}

function write(e: Env, rel: string, text: string): void {
  mkdirSync(dirname(join(e.worktree, rel)), { recursive: true });
  writeFileSync(join(e.worktree, rel), text);
}

function run(e: Env, args: readonly string[], extra: Record<string, string> = {}) {
  const res = spawnSync(
    process.execPath,
    [SCRIPT, '--trusted', e.trusted, '--worktree', e.worktree, ...args],
    { encoding: 'utf8', env: { ...process.env, FAKE_LOG: e.log, ...extra } },
  );
  return {
    status: res.status,
    stderr: res.stderr,
    report: JSON.parse(res.stdout) as {
      ok: boolean;
      files: Record<string, unknown>[];
      skipped: { path: string; reason: string }[];
      restored: boolean;
      error: string | null;
    },
  };
}

it('[D10-292] CLI: formats the matching files and reports a format-only summary', () => {
  const e = env('ok');
  write(e, 'test/spec/a.test.ts', 'it("a", () => expect(oldName).toBe(1))\n');
  write(e, 'test/spec/notes.md', 'x "y"\n');
  write(e, 'src/b.ts', 'export const b = "b"\n');
  const list = join(e.root, 'files.txt');
  writeFileSync(list, 'test/spec/a.test.ts\ntest/spec/notes.md\nsrc/b.ts\n');
  const res = run(e, [
    '--globs',
    'test/spec/**,test/{acceptance,properties}/**',
    '--files-from',
    list,
  ]);
  expect(res.status, res.stderr).toBe(0);
  expect(res.report.ok).toBe(true);
  expect(res.report.restored).toBe(false);
  expect(res.report.files).toEqual([
    {
      path: 'test/spec/a.test.ts',
      changed: true,
      lines_before: 1,
      lines_after: 1,
      lines_added: 1,
      lines_removed: 1,
      format_only: true,
      eslint_fatal: null,
    },
  ]);
  expect(res.report.skipped).toEqual([
    { path: 'test/spec/notes.md', reason: 'not a script file' },
    { path: 'src/b.ts', reason: 'outside the globs' },
  ]);
  expect(readFileSync(join(e.worktree, 'test/spec/a.test.ts'), 'utf8')).toBe(
    "it('a', () => expect(oldName).toBe(1));\n",
  );
  expect(readFileSync(join(e.worktree, 'src/b.ts'), 'utf8')).toBe('export const b = "b"\n');
  // Layout fixes only, with the trusted configuration, run in the worktree.
  const eslintArgv = readFileSync(join(e.log, 'eslint.argv'), 'utf8').split('\n');
  expect(eslintArgv).toEqual(
    expect.arrayContaining([
      '--config',
      join(e.trusted, 'eslint.config.js'),
      '--fix',
      '--fix-type',
      'layout',
      './test/spec/a.test.ts',
    ]),
  );
  expect(readFileSync(join(e.log, 'eslint.cwd'), 'utf8').trim()).toBe(e.worktree);
  const prettierArgv = readFileSync(join(e.log, 'prettier.argv'), 'utf8').split('\n');
  expect(prettierArgv).toEqual(
    expect.arrayContaining(['--config', join(e.trusted, '.prettierrc.json'), '--write']),
  );
  expect(prettierArgv).not.toContain('./src/b.ts');
});

it('[D10-292] CLI: a change beyond formatting restores every file and exits 1', () => {
  const e = env('rename');
  const a = 'it("a", () => expect(oldName).toBe(1))\n';
  const b = 'it("b", () => expect(2).toBe(2))\n';
  write(e, 'test/spec/a.test.ts', a);
  write(e, 'test/spec/b.test.ts', b);
  const res = run(e, ['test/spec/b.test.ts', 'test/spec/a.test.ts'], { FAKE_PRETTIER: 'rename' });
  expect(res.status).toBe(1);
  expect(res.report.ok).toBe(false);
  expect(res.report.restored).toBe(true);
  expect(res.report.error).toContain('test/spec/a.test.ts');
  expect(res.report.files.map((f) => [f['path'], f['format_only']])).toEqual([
    ['test/spec/b.test.ts', true],
    ['test/spec/a.test.ts', false],
  ]);
  expect(readFileSync(join(e.worktree, 'test/spec/a.test.ts'), 'utf8')).toBe(a);
  expect(readFileSync(join(e.worktree, 'test/spec/b.test.ts'), 'utf8')).toBe(b);
});

it('[D10-292] CLI: a failing prettier restores the files and exits 2', () => {
  const e = env('fail');
  const a = 'it("a", () => 1)\n';
  write(e, 'test/spec/a.test.ts', a);
  const res = run(e, ['test/spec/a.test.ts'], { FAKE_PRETTIER_EXIT: '2' });
  expect(res.status).toBe(2);
  expect(res.report.restored).toBe(true);
  expect(res.report.error).toContain('prettier failed');
  expect(readFileSync(join(e.worktree, 'test/spec/a.test.ts'), 'utf8')).toBe(a);
});

it('[D10-292] CLI: nothing to format needs no tools; unsafe paths are skipped', () => {
  const e = env('none');
  rmSync(join(e.trusted, 'node_modules'), { recursive: true, force: true });
  write(e, 'outside.ts', 'x\n');
  symlinkSync(join(e.worktree, 'outside.ts'), join(e.worktree, 'test', 'spec', 'link.test.ts'));
  const res = run(e, ['../x.ts', 'test/spec/link.test.ts', 'test/spec/*.ts', 'test/spec/gone.ts']);
  expect(res.status, res.stderr).toBe(0);
  expect(res.report).toEqual({
    ok: true,
    files: [],
    skipped: [
      { path: '../x.ts', reason: 'not a relative path' },
      { path: 'test/spec/link.test.ts', reason: 'not a regular file' },
      { path: 'test/spec/*.ts', reason: 'glob characters in the path' },
      { path: 'test/spec/gone.ts', reason: 'missing' },
    ],
    restored: false,
    error: null,
  });
});

it('[D10-292] CLI: a missing tool in the trusted root is an error (exit 2), files untouched', () => {
  const e = env('missing');
  rmSync(join(e.trusted, 'node_modules', '.bin', 'prettier'));
  write(e, 'test/spec/a.test.ts', 'x\n');
  const res = run(e, ['test/spec/a.test.ts']);
  expect(res.status).toBe(2);
  expect(res.report.error).toContain('missing in the trusted root');
  expect(readFileSync(join(e.worktree, 'test/spec/a.test.ts'), 'utf8')).toBe('x\n');
});
