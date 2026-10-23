// format-tests.ts — formats the rule-test files an independent Claude test phase handed back
// (claude-run.sh impl --phase test, ops/approvals.yaml id 36; orchestrator decision D10-292).
// That context has no shell, so it cannot run prettier; without this step `format:check` of
// verify:fast fails on whitespace and every such diff had to be checked by hand (D10-206).
//
//   node tools/agent/format-tests.ts --trusted <dir> --worktree <dir> [--globs <glob,glob>]...
//                                    (--files-from <file> | <file>...)
//
// Files are relative to the worktree (one per line in --files-from). Only `.ts`, `.tsx`, `.js`,
// `.mjs`, `.cjs` files that match one of the --globs (when given) are formatted; the others, and
// paths that are absolute, contain `..` or glob characters, are not a regular file or leave the
// worktree through a symbolic link, are listed under `skipped`. For the formatted files:
//   1. the original content is kept;
//   2. the trusted root's eslint runs with the trusted eslint.config.js, `--fix --fix-type
//      layout` (layout fixes only; remaining rule problems are not reported as a failure);
//   3. the trusted root's prettier runs with the trusted .prettierrc.json, `--write`;
//   4. both versions are normalized (formatOnly below) and must be equal.
// The tools are `<trusted>/node_modules/.bin/{eslint,prettier}`, run in the worktree.
//
// Output (stdout): one JSON document { ok, files: [{ path, changed, lines_before, lines_after,
// lines_added, lines_removed, format_only, eslint_fatal }], skipped: [{ path, reason }],
// restored, error }.
// Exit codes: 0 ok (only format changes, or nothing to do); 1 a change was not format-only:
// every file was restored to its original content; 2 usage or tool error (files restored too).
//
// What the normalization compares (the safety net; what is relied on is that only layout fixes
// and prettier run): outside strings, template text, regular expressions and comments every
// whitespace character, `;`, `,`, `(` and `)` is removed (one space stays where it was all that
// separated two words or numbers, so `f(a, b)` is not `f(ab)`); strings compare by content with the
// quote style and escaped quotes unified; a quoted object key whose content is an identifier or a
// plain number compares like the bare key; a leading `|` / `&` of a TypeScript union /
// intersection (after `=`, `:`, `(`, `<`, `,`, `[`, `{`, `=>`, `as`, `satisfies`, `extends`, `is`,
// `keyof`) is dropped; numbers compare in prettier's normal form (lower case, no `+` in the
// exponent, leading zero, no trailing fraction zeros or dot); whitespace inside comments is
// ignored; CRLF counts as LF. Known limits — such changes are seen as format-only:
//   - code that differs only in parentheses, commas or semicolons (`a * (b + c)` vs `a * b + c`,
//     `f(a)(b)` vs `f(a, b)`), or only in whitespace next to punctuation (`a ++b` vs `a++ b`), or
//     where a line break changes automatic semicolon insertion;
//   - a string followed by `:` or `?:` after `{`, `,`, `;`, a closing bracket or a word other
//     than a keyword (`case`, `return`, …) is taken for an object or type member key, so
//     `{ 'a': x }` equals `{ a: x }` (intended) but the same holds in rarer non-key positions;
//   - the lexer is not a parser: a `/` is taken for a regular expression after an operator,
//     an opening bracket or a keyword; JSX text is lexed as code (an apostrophe in it starts a
//     string up to the end of the line), so reflowed JSX text usually fails the check instead.
// Such cases fail closed or pass only when the code means the same; template text formatted by
// prettier's embedded formatting (css`…`, graphql, html, markdown) is a change and fails.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { matchesAny, splitTopLevelCommas } from '../lib/glob.ts';

export const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
const TOOL_TIMEOUT_MS = 300_000;

type SegKind = 'code' | 'str' | 'tpl' | 're' | 'cmt';
export type Segment = { k: SegKind; t: string };

const IDENT = /[A-Za-z0-9_$\u0080-￿]/;
const NUMBER =
  /(?:0[xXbBoO][0-9a-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/y;
const REGEX_AFTER_CHARS = new Set('(,=:[!&|?{};+-*%>~^'.split(''));
// A `|` / `&` here has no left operand: the leading bar of a multi-line union / intersection type
// that prettier adds or removes.
const LEADING_BAR_AFTER_CHARS = new Set('=:(<,[{'.split(''));
const LEADING_BAR_AFTER_WORDS = new Set(['as', 'satisfies', 'extends', 'is', 'keyof']);
const REGEX_AFTER_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/** Prettier's normal form of a numeric literal, so that a reformatted number compares equal. */
export function canonNumber(raw: string): string {
  let s = raw.toLowerCase();
  if (/^0[xbo]/.test(s)) return s;
  let suffix = '';
  if (s.endsWith('n')) {
    suffix = 'n';
    s = s.slice(0, -1);
  }
  let exp = '';
  const e = s.indexOf('e');
  if (e !== -1) {
    exp = `e${s.slice(e + 1).replace('+', '')}`;
    s = s.slice(0, e);
  }
  const dot = s.indexOf('.');
  if (dot !== -1) {
    const int = s.slice(0, dot) === '' ? '0' : s.slice(0, dot);
    const frac = s.slice(dot + 1).replace(/[0_]+$/, '');
    s = frac === '' ? int : `${int}.${frac}`;
  }
  return `${s}${exp}${suffix}`;
}

/** Splits source text into code, string, template text, regular expression and comment parts. */
export function segments(source: string): Segment[] {
  const src = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const out: Segment[] = [];
  let code = '';
  let lastWord = '';
  let lastChar = '';
  // Brace depth inside each open `${ … }` of a template literal, innermost last.
  const templates: number[] = [];
  const flush = (): void => {
    if (code !== '') out.push({ k: 'code', t: code });
    code = '';
  };
  const push = (k: SegKind, t: string): void => {
    flush();
    out.push({ k, t });
  };
  let i = 0;
  // Two words stay apart (`let x` is not `letx`): prettier never joins or splits them.
  let spaced = false;
  const separator = (): string => {
    const sep = spaced && IDENT.test(code.slice(-1)) ? ' ' : '';
    spaced = false;
    return sep;
  };
  /** Reads template text from i up to the closing backtick or `${`. */
  const templateChunk = (): void => {
    let text = '';
    while (i < src.length) {
      const c = src[i] ?? '';
      if (c === '\\') {
        text += src.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        push('tpl', text);
        code += '`';
        i += 1;
        lastChar = '`';
        lastWord = '';
        return;
      } else if (c === '$' && src[i + 1] === '{') {
        push('tpl', text);
        code += '${';
        i += 2;
        templates.push(0);
        lastChar = '{';
        lastWord = '';
        return;
      } else {
        text += c;
        i += 1;
      }
    }
    push('tpl', text);
  };
  while (i < src.length) {
    const c = src[i] ?? '';
    const next = src[i + 1] ?? '';
    if (/\s/.test(c)) {
      i += 1;
      spaced = true;
      continue;
    }
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      push('cmt', src.slice(i, stop).replace(/\s+/g, ''));
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      push('cmt', src.slice(i, stop).replace(/\s+/g, ''));
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      let text = '';
      i += 1;
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const escaped = src[i + 1] ?? '';
          text += escaped === "'" || escaped === '"' ? escaped : `\\${escaped}`;
          i += 2;
        } else {
          text += src[i];
          i += 1;
        }
      }
      if (src[i] === c) i += 1;
      push('str', text);
      lastChar = '"';
      lastWord = '';
      continue;
    }
    if (c === '`') {
      code += '`';
      i += 1;
      templateChunk();
      continue;
    }
    if (
      (c === '|' || c === '&') &&
      !'|&='.includes(next) &&
      (LEADING_BAR_AFTER_CHARS.has(lastChar) ||
        LEADING_BAR_AFTER_WORDS.has(lastWord) ||
        code.endsWith('=>'))
    ) {
      i += 1;
      continue;
    }
    // `/>` after `}` closes a JSX element (`<A b={c} />`); elsewhere `/>…/` is a regex.
    if (c === '/' && !(next === '>' && lastChar === '}')) {
      const regexHere =
        lastChar === '' || REGEX_AFTER_CHARS.has(lastChar) || REGEX_AFTER_WORDS.has(lastWord);
      if (regexHere) {
        let text = '/';
        let inClass = false;
        i += 1;
        while (i < src.length && src[i] !== '\n') {
          const r = src[i] ?? '';
          if (r === '\\') {
            text += src.slice(i, i + 2);
            i += 2;
            continue;
          }
          text += r;
          i += 1;
          if (r === '[') inClass = true;
          else if (r === ']') inClass = false;
          else if (r === '/' && !inClass) break;
        }
        while (i < src.length && /[a-z]/i.test(src[i] ?? '')) {
          text += src[i];
          i += 1;
        }
        push('re', text);
        lastChar = '/';
        lastWord = '';
        continue;
      }
    }
    const prev = code.slice(-1);
    if ((/\d/.test(c) || (c === '.' && /\d/.test(next))) && !(prev !== '' && IDENT.test(prev))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(src);
      if (m !== null && m[0] !== '' && !(c === '.' && lastChar === '.')) {
        code += separator() + canonNumber(m[0]);
        i += m[0].length;
        lastChar = '0';
        lastWord = '';
        continue;
      }
    }
    if (IDENT.test(c)) {
      let word = '';
      while (i < src.length && IDENT.test(src[i] ?? '')) {
        word += src[i];
        i += 1;
      }
      code += separator() + word;
      lastWord = word;
      lastChar = 'a';
      continue;
    }
    if (templates.length > 0) {
      const top = templates.length - 1;
      if (c === '{') {
        templates[top] = (templates[top] ?? 0) + 1;
      } else if (c === '}') {
        if (templates[top] === 0) {
          templates.pop();
          code += '}';
          i += 1;
          templateChunk();
          continue;
        }
        templates[top] = (templates[top] ?? 0) - 1;
      }
    }
    // A TypeScript non-null assertion (`x!`) ends an operand: a `/` after it divides.
    const postfixBang = c === '!' && next !== '=' && /[\w$)\]]/.test(code.slice(-1)) && !spaced;
    code += c;
    lastChar = postfixBang ? 'a' : c;
    lastWord = '';
    spaced = false;
    i += 1;
  }
  flush();
  return out;
}

const NOT_BEFORE_KEY = new Set([...REGEX_AFTER_WORDS, 'case']);

/** True when code ending like this can be followed by an object or type member key. */
function keyBefore(code: string): boolean {
  if (code === '') return true;
  if (code.endsWith('=>') || !/[{,;)\]}>\w$\u0080-\uffff]$/u.test(code)) return false;
  const word = /[\w$\u0080-\uffff]+$/u.exec(code)?.[0];
  return word === undefined || !NOT_BEFORE_KEY.has(word);
}

const KEY_CONTENT = /^(?:[\p{ID_Start}_$][\p{ID_Continue}$\u200c\u200d]*|\d+)$/u;

/** The normalized form compared by formatOnly (see the file header). */
export function normalize(source: string): Segment[] {
  const segs = segments(source);
  const prevCode = (at: number): string => {
    for (let j = at - 1; j >= 0; j -= 1) {
      const s = segs[j];
      if (s !== undefined && s.k !== 'cmt') return s.k === 'code' ? s.t : '';
    }
    return '';
  };
  // A quoted key that prettier may unquote (quoteProps: as-needed) compares like the bare key.
  const keyed: Segment[] = segs.map((s, at) => {
    const after = segs[at + 1];
    if (
      s.k === 'str' &&
      KEY_CONTENT.test(s.t) &&
      after?.k === 'code' &&
      /^\??:/.test(after.t) &&
      keyBefore(prevCode(at).replace(/[()]/g, ' ').trimEnd())
    ) {
      return { k: 'code', t: s.t };
    }
    return s;
  });
  const merged: Segment[] = [];
  for (const s of keyed) {
    const last = merged[merged.length - 1];
    if (s.k === 'code' && last?.k === 'code') {
      const apart = IDENT.test(last.t.slice(-1)) && IDENT.test(s.t.charAt(0));
      last.t += (apart ? ' ' : '') + s.t;
    } else merged.push({ ...s });
  }
  const out: Segment[] = [];
  for (const s of merged) {
    if (s.k === 'code') {
      // Removed punctuation between two words leaves the space that keeps them apart.
      const t = s.t.replace(/[;,() ]+/g, (run: string, at: number, all: string) =>
        IDENT.test(all[at - 1] ?? '') && IDENT.test(all[at + run.length] ?? '') ? ' ' : '',
      );
      if (t !== '') out.push({ k: 'code', t });
    } else {
      out.push(s);
    }
  }
  return out;
}

/** True when the two versions differ only in formatting (see the file header for the limits). */
export function formatOnly(before: string, after: string): boolean {
  return JSON.stringify(normalize(before)) === JSON.stringify(normalize(after));
}

function lines(text: string): string[] {
  if (text === '') return [];
  const all = text.replace(/\r\n?/g, '\n').split('\n');
  if (all[all.length - 1] === '') all.pop();
  return all;
}

/** Lines added and removed between two texts (longest common subsequence of lines). */
export function lineStats(
  before: string,
  after: string,
): {
  lines_before: number;
  lines_after: number;
  lines_added: number;
  lines_removed: number;
} {
  const a = lines(before);
  const b = lines(after);
  let common = 0;
  if (a.length * b.length <= 25_000_000) {
    let prev = new Uint32Array(b.length + 1);
    let cur = new Uint32Array(b.length + 1);
    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= b.length; j += 1) {
        cur[j] =
          a[i - 1] === b[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
      }
      [prev, cur] = [cur, prev];
    }
    common = prev[b.length] ?? 0;
  } else {
    // Very large files: count lines that occur in both as a multiset (an upper bound).
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    for (const line of b) {
      const n = counts.get(line) ?? 0;
      if (n > 0) {
        common += 1;
        counts.set(line, n - 1);
      }
    }
  }
  return {
    lines_before: a.length,
    lines_after: b.length,
    lines_added: b.length - common,
    lines_removed: a.length - common,
  };
}

export type FileResult = {
  path: string;
  changed: boolean;
  lines_before: number;
  lines_after: number;
  lines_added: number;
  lines_removed: number;
  format_only: boolean;
  eslint_fatal: string | null;
};

export type Report = {
  ok: boolean;
  files: FileResult[];
  skipped: { path: string; reason: string }[];
  restored: boolean;
  error: string | null;
};

class UsageError extends Error {}

/** Why a candidate is not formatted, or null when it is. */
export function skipReason(worktree: string, rel: string, globs: readonly string[]): string | null {
  if (rel === '' || isAbsolute(rel) || rel.split('/').includes('..')) return 'not a relative path';
  if (/[*?[\]{}!\\]/.test(rel)) return 'glob characters in the path';
  if (!EXTENSIONS.some((ext) => rel.endsWith(ext))) return 'not a script file';
  if (globs.length > 0 && !matchesAny(rel, globs)) return 'outside the globs';
  const abs = join(worktree, rel);
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    return 'missing';
  }
  if (!stat.isFile()) return 'not a regular file';
  const real = realpathSync(abs);
  const root = realpathSync(worktree);
  if (real !== join(root, rel) && !real.startsWith(root + sep)) return 'outside the worktree';
  if (real !== join(root, rel)) return 'reached through a symbolic link';
  return null;
}

type RunOptions = { trusted: string; worktree: string; globs: string[]; files: string[] };

function runTool(bin: string, args: string[], cwd: string) {
  return spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: TOOL_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function shortText(text: string | null | undefined): string {
  return (text ?? '').trim().split('\n').slice(0, 5).join(' | ').slice(0, 500);
}

/** Formats the files and checks the result; restores every file when the check fails. */
export function formatTests(opts: RunOptions): { report: Report; exitCode: number } {
  const report: Report = { ok: true, files: [], skipped: [], restored: false, error: null };
  const worktree = realpathSync(resolve(opts.worktree));
  const targets: string[] = [];
  for (const rel of opts.files) {
    if (targets.includes(rel)) continue;
    const reason = skipReason(worktree, rel, opts.globs);
    if (reason === null) targets.push(rel);
    else report.skipped.push({ path: rel, reason });
  }
  if (targets.length === 0) return { report, exitCode: 0 };

  const trusted = resolve(opts.trusted);
  const eslint = join(trusted, 'node_modules', '.bin', 'eslint');
  const prettier = join(trusted, 'node_modules', '.bin', 'prettier');
  const eslintConfig = join(trusted, 'eslint.config.js');
  const prettierConfig = join(trusted, '.prettierrc.json');
  for (const needed of [eslint, prettier, eslintConfig, prettierConfig]) {
    if (!existsSync(needed)) {
      report.ok = false;
      report.error = `missing in the trusted root: ${needed}`;
      return { report, exitCode: 2 };
    }
  }

  const originals = new Map<string, Buffer>();
  for (const rel of targets) originals.set(rel, readFileSync(join(worktree, rel)));
  const restore = (): void => {
    for (const [rel, content] of originals) writeFileSync(join(worktree, rel), content);
    report.restored = true;
  };
  const fail = (message: string, exitCode: number) => {
    restore();
    report.ok = false;
    report.error = message;
    return { report, exitCode };
  };
  try {
    return checkFormatted(worktree, targets, originals, report, fail, {
      eslint,
      prettier,
      eslintConfig,
      prettierConfig,
    });
  } catch (error) {
    report.files = [];
    return fail(error instanceof Error ? error.message : String(error), 2);
  }
}

type Fail = (message: string, exitCode: number) => { report: Report; exitCode: number };
type Tools = { eslint: string; prettier: string; eslintConfig: string; prettierConfig: string };

function checkFormatted(
  worktree: string,
  targets: readonly string[],
  originals: ReadonlyMap<string, Buffer>,
  report: Report,
  fail: Fail,
  { eslint, prettier, eslintConfig, prettierConfig }: Tools,
): { report: Report; exitCode: number } {
  // `./` keeps a file name from being read as an option.
  const args = targets.map((rel) => `./${rel}`);

  const fatal = new Map<string, string>();
  const lint = runTool(
    eslint,
    [
      '--config',
      eslintConfig,
      '--fix',
      '--fix-type',
      'layout',
      '--format',
      'json',
      '--no-warn-ignored',
      ...args,
    ],
    worktree,
  );
  if (lint.error !== undefined || (lint.status !== 0 && lint.status !== 1)) {
    return fail(
      `eslint failed (exit ${String(lint.status)}): ${shortText(lint.error?.message ?? lint.stderr)}`,
      2,
    );
  }
  try {
    const results = JSON.parse(lint.stdout) as {
      filePath?: string;
      messages?: { fatal?: boolean; message?: string }[];
    }[];
    for (const result of results) {
      const message = (result.messages ?? []).find((m) => m.fatal === true);
      if (message === undefined || typeof result.filePath !== 'string') continue;
      fatal.set(relative(worktree, result.filePath).split(sep).join('/'), message.message ?? '');
    }
  } catch {
    return fail(`eslint printed no JSON report: ${shortText(lint.stdout)}`, 2);
  }

  const pretty = runTool(
    prettier,
    ['--config', prettierConfig, '--no-editorconfig', '--log-level', 'warn', '--write', ...args],
    worktree,
  );
  if (pretty.error !== undefined || pretty.status !== 0) {
    return fail(
      `prettier failed (exit ${String(pretty.status)}): ${shortText(pretty.error?.message ?? pretty.stderr)}`,
      2,
    );
  }

  for (const rel of targets) {
    const before = (originals.get(rel) ?? Buffer.alloc(0)).toString('utf8');
    let after: string;
    try {
      after = readFileSync(join(worktree, rel), 'utf8');
    } catch {
      return fail(`${rel} is gone after formatting`, 2);
    }
    const changed = before !== after;
    report.files.push({
      path: rel,
      changed,
      ...lineStats(before, after),
      format_only: !changed || formatOnly(before, after),
      eslint_fatal: fatal.get(rel) ?? null,
    });
  }
  const bad = report.files.filter((f) => !f.format_only).map((f) => f.path);
  if (bad.length > 0) {
    return fail(`not a format-only change: ${bad.join(', ')} (every file restored)`, 1);
  }
  return { report, exitCode: 0 };
}

function parseArgs(argv: readonly string[]): RunOptions {
  let trusted: string | undefined;
  let worktree: string | undefined;
  const globs: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const value = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new UsageError(`${arg} needs a value`);
      i += 1;
      return v;
    };
    if (arg === '--trusted') trusted = value();
    else if (arg === '--worktree') worktree = value();
    else if (arg === '--globs') {
      for (const glob of splitTopLevelCommas(value())) if (glob !== '') globs.push(glob);
    } else if (arg === '--files-from') {
      for (const line of readFileSync(value(), 'utf8').split('\n'))
        if (line !== '') files.push(line);
    } else if (arg.startsWith('--')) throw new UsageError(`unknown option: ${arg}`);
    else files.push(arg);
  }
  if (trusted === undefined || worktree === undefined) {
    throw new UsageError(
      'usage: format-tests.ts --trusted <dir> --worktree <dir> [--globs <g,g>]... (--files-from <file> | <file>...)',
    );
  }
  for (const dir of [trusted, worktree]) {
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) {
      throw new UsageError(`not a directory: ${dir}`);
    }
  }
  return { trusted, worktree, globs, files };
}

if (import.meta.main) {
  let code = 2;
  try {
    const { report, exitCode } = formatTests(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.error !== null) process.stderr.write(`format-tests.ts: ${report.error}\n`);
    code = exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report: Report = { ok: false, files: [], skipped: [], restored: false, error: message };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.stderr.write(`format-tests.ts: ${message}\n`);
  }
  process.exitCode = code;
}
