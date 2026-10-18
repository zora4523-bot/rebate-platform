// Which rule tests of a file changed since the base (CT-06p; red check, 规划/11 §2.3 step 3).
//
// A rule-test file that already existed at the base and is changed again by a task (an exact
// assertion synchronised with a new column, a new test added next to the old ones) needs only its
// new and changed tests red: the unchanged ones were shown red when they were added and may pass
// on the new skeleton. This module tells them apart, and it does so conservatively — whatever it
// cannot read for certain counts as changed (the test must be red, as before):
//
// - The file is cut into test blocks — every outermost call of `it` / `test` imported from
//   'vitest' (with its modifier chain: `.each(table)`, `.concurrent`, `.for`, type arguments …, and the
//   `;` that ends it) — and the shared rest: imports, helpers, top-level constants and tables,
//   hooks, loops, `describe` headers and bodies. Both are compared token by token: comments and
//   the amount of whitespace do not count, a line break between two tokens does (ASI), string,
//   template and regular-expression literals count byte for byte.
// - Any difference in the shared rest makes every test of the file changed (a helper, a hook, an
//   import, a top-level table or a describe title can change what any test means).
// - A test block is unchanged only when the same block (same text at the same place of the
//   shared rest — same number of shared tokens before it — in the same describes)
//   occurs exactly once at the base and exactly once at the head, and the unchanged blocks keep
//   their relative order (a moved test is changed: the order of a file's tests can matter).
//   A renamed test is a new block; a row of a parameterised table (`it.each([...])`) that changed
//   changes the block, so every case of that table must be red.
// - A test of the report belongs to a block through the block's title pattern: the describe
//   titles and the test title, exact for plain literals, a wildcard for every `${…}` of a template,
//   for every non-literal title and, in `.each` / `.for` titles, for every `%x` and `$name`
//   Vitest formats; an unknown suite prefix is always allowed. A test is exempt only when exactly
//   one block's pattern matches its full name and that block is unchanged. Patterns are supersets
//   of the names a block can produce, so a test whose own block changed always matches that block.
// - A file that cannot be tokenized (an unterminated literal, unbalanced brackets, JSX) is judged
//   as a whole.
//
// Test-support files (a helper, fixture or data file the task changed inside its test_paths) are
// judged by mayReadSupport: a file that may read one is judged as a whole (see there). Import
// specifiers are resolved to repository paths first (CT-06w): an import of a same-named file in
// another directory is not a read of the support file.
//
// Node built-ins only; pure functions (the caller reads the files).

export class TestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestParseError';
  }
}

export type Token = {
  kind: 'id' | 'num' | 'str' | 'tpl' | 're' | 'punct';
  /** Raw source text (a template literal includes its `${…}` expressions). */
  text: string;
  /** A line break occurs in the whitespace or comments before the token. */
  nl: boolean;
  /** Offset of the token in the source. */
  start?: number;
  /** The exact whitespace and comments between the previous token and this one. */
  gap?: string;
  /** str: the cooked value (null when an escape cannot be decoded for certain). */
  value?: string | null;
  /** tpl: the cooked static parts around the `${…}` expressions (null when not decodable). */
  parts?: (string | null)[];
  /** tpl: the tokens of its `${…}` expressions, in order. */
  inner?: Token[];
};

const PUNCTUATORS = [
  '>>>=',
  '...',
  '===',
  '!==',
  '**=',
  '<<=',
  '>>=',
  '>>>',
  '&&=',
  '||=',
  '??=',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '**',
  '<<',
  '>>',
];
const SINGLE_PUNCTUATORS = '{}()[];,<>+-*/%&|^!~?:=.@';
/** Identifiers after which a `/` starts a regular expression, not a division. */
const BEFORE_EXPRESSION = new Set([
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

function lineTerminator(c: string | undefined): boolean {
  return c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
}

function idStart(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z_$\u0080-\uffff]/.test(c) && !/\s/.test(c);
}

function idPart(c: string | undefined): boolean {
  return c !== undefined && /[\w$\u0080-\uffff]/.test(c) && !/\s/.test(c);
}

/**
 * The cooked value of a string or template literal body, or null when an escape cannot be
 * decoded for certain (a legacy octal escape, a malformed \x / \u).
 */
export function cook(body: string, template: boolean): string | null {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i] as string;
    if (c !== '\\') {
      if (template && c === '\r') {
        // Template literals normalise CRLF and CR to LF.
        out += '\n';
        if (body[i + 1] === '\n') i += 1;
      } else {
        out += c;
      }
      continue;
    }
    i += 1;
    const d = body[i];
    if (d === undefined) return null;
    if (d === 'n') out += '\n';
    else if (d === 't') out += '\t';
    else if (d === 'r') out += '\r';
    else if (d === 'b') out += '\b';
    else if (d === 'f') out += '\f';
    else if (d === 'v') out += '\v';
    else if (d === '0') {
      if (/[0-9]/.test(body[i + 1] ?? '')) return null;
      out += '\0';
    } else if (d === 'x') {
      const hex = body.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
    } else if (d === 'u') {
      if (body[i + 1] === '{') {
        const end = body.indexOf('}', i + 2);
        const hex = end < 0 ? '' : body.slice(i + 2, end);
        if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) return null;
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) return null;
        out += String.fromCodePoint(cp);
        i = end;
      } else {
        const hex = body.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      }
    } else if (d === '\r') {
      // A line continuation: nothing.
      if (body[i + 1] === '\n') i += 1;
    } else if (d === '\n' || d === '\u2028' || d === '\u2029') {
      // A line continuation: nothing.
    } else if (/[1-9]/.test(d)) {
      return null;
    } else {
      out += d;
    }
  }
  return out;
}

function regexAllowed(prev: Token | undefined): boolean {
  if (prev === undefined) return true;
  if (prev.kind === 'id') return BEFORE_EXPRESSION.has(prev.text);
  if (prev.kind !== 'punct') return false;
  return ![')', ']', '}', '++', '--'].includes(prev.text);
}

/** End (exclusive) of the regular expression literal starting at `i`, or null when it is none. */
function scanRegex(src: string, i: number): number | null {
  let j = i + 1;
  let inClass = false;
  for (;;) {
    const c = src[j];
    if (c === undefined || lineTerminator(c)) return null;
    if (c === '\\') {
      if (lineTerminator(src[j + 1])) return null;
      j += 2;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
    } else if (c === '[') {
      inClass = true;
    } else if (c === '/') {
      break;
    }
    j += 1;
  }
  j += 1;
  while (idPart(src[j])) j += 1;
  return j;
}

type Lexed = { tokens: Token[]; end: number };

function lex(src: string, start: number, inTemplate: boolean): Lexed {
  const tokens: Token[] = [];
  const n = src.length;
  let i = start;
  let nl = false;
  let depth = 0;
  let prevEnd = start;
  while (i < n) {
    const c = src[i] as string;
    if (lineTerminator(c)) {
      nl = true;
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && !lineTerminator(src[i])) i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new TestParseError('unterminated comment');
      if (/[\n\r\u2028\u2029]/.test(src.slice(i, end))) nl = true;
      i = end + 2;
      continue;
    }
    if (i === 0 && c === '#' && src[1] === '!') {
      while (i < n && !lineTerminator(src[i])) i += 1;
      continue;
    }
    let token: Token;
    const at = i;
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (;;) {
        const d = src[j];
        if (d === undefined || d === '\n' || d === '\r') {
          throw new TestParseError('unterminated string literal');
        }
        if (d === '\\') {
          j += src[j + 1] === '\r' && src[j + 2] === '\n' ? 3 : 2;
          continue;
        }
        if (d === c) break;
        j += 1;
      }
      token = {
        kind: 'str',
        text: src.slice(i, j + 1),
        nl,
        value: cook(src.slice(i + 1, j), false),
      };
      i = j + 1;
    } else if (c === '`') {
      const parts: (string | null)[] = [];
      const inner: Token[] = [];
      let j = i + 1;
      let seg = j;
      for (;;) {
        const d = src[j];
        if (d === undefined) throw new TestParseError('unterminated template literal');
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '`') {
          parts.push(cook(src.slice(seg, j), true));
          break;
        }
        if (d === '$' && src[j + 1] === '{') {
          parts.push(cook(src.slice(seg, j), true));
          const expression = lex(src, j + 2, true);
          inner.push(...expression.tokens);
          j = expression.end;
          seg = j;
          continue;
        }
        j += 1;
      }
      token = { kind: 'tpl', text: src.slice(i, j + 1), nl, parts, inner };
      i = j + 1;
    } else if (idStart(c) || (c === '#' && idStart(src[i + 1]))) {
      let j = i + 1;
      while (idPart(src[j])) j += 1;
      token = { kind: 'id', text: src.slice(i, j), nl };
      i = j;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j] as string)) j += 1;
      token = { kind: 'num', text: src.slice(i, j), nl };
      i = j;
    } else {
      const prev = tokens[tokens.length - 1];
      const re = c === '/' && regexAllowed(prev) ? scanRegex(src, i) : null;
      if (re !== null) {
        token = { kind: 're', text: src.slice(i, re), nl };
        i = re;
      } else {
        const multi = PUNCTUATORS.find((p) => src.startsWith(p, i));
        const text = multi ?? (SINGLE_PUNCTUATORS.includes(c) ? c : null);
        if (text === null) throw new TestParseError(`unexpected character ${JSON.stringify(c)}`);
        token = { kind: 'punct', text, nl };
        i += text.length;
      }
    }
    token.start = at;
    token.gap = src.slice(prevEnd, at);
    prevEnd = i;
    if (inTemplate && token.kind === 'punct') {
      if (token.text === '{') depth += 1;
      if (token.text === '}') {
        if (depth === 0) return { tokens, end: i };
        depth -= 1;
      }
    }
    tokens.push(token);
    nl = false;
  }
  if (inTemplate) throw new TestParseError('unterminated template expression');
  return { tokens, end: n };
}

/** The tokens of a JavaScript / TypeScript source (no JSX); throws TestParseError. */
export function tokenize(source: string): Token[] {
  return lex(source, 0, false).tokens;
}

/** Index of the matching bracket of every bracket token; throws on unbalanced brackets. */
function matchBrackets(tokens: readonly Token[]): number[] {
  const match = new Array<number>(tokens.length).fill(-1);
  const stack: number[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  tokens.forEach((t, i) => {
    if (t.kind !== 'punct') return;
    if (t.text === '(' || t.text === '[' || t.text === '{') {
      stack.push(i);
    } else if (t.text in pairs) {
      const open = stack.pop();
      if (open === undefined || tokens[open]?.text !== pairs[t.text]) {
        throw new TestParseError(`unbalanced "${t.text}"`);
      }
      match[open] = i;
      match[i] = open;
    }
  });
  if (stack.length > 0) throw new TestParseError('unclosed bracket');
  return match;
}

/**
 * The separator before token k in a normalised text: a line break when the gap has one, else
 * one space — except on a line that has a division `/` or `/=`, where the exact gap is kept: a
 * regular expression literal the lexer takes for a division (after `)` of an `if (…)`, after a
 * `}`) is then compared byte for byte, its spaces included (Codex review r3, S2).
 */
type Separator = (k: number) => string;

function separators(source: string, tokens: readonly Token[]): Separator {
  const breaks: number[] = [];
  for (const m of source.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) breaks.push(m.index ?? 0);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((breaks[mid] as number) < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const division = new Set<number>();
  for (const t of tokens) {
    if (t.kind === 'punct' && (t.text === '/' || t.text === '/='))
      division.add(lineOf(t.start ?? 0));
  }
  return (k) => {
    const t = tokens[k] as Token;
    if (t.nl) return '\n';
    return division.has(lineOf(t.start ?? 0)) ? (t.gap ?? ' ') : ' ';
  };
}

/** Normalised text of tokens[from..to]: see separators. */
function joinTokens(tokens: readonly Token[], from: number, to: number, sep: Separator): string {
  let out = '';
  for (let i = from; i <= to; i += 1) {
    const t = tokens[i] as Token;
    out += i === from ? t.text : `${sep(i)}${t.text}`;
  }
  return out;
}

/** The local names of `it` / `test` (tests) and `describe` / `suite` imported from 'vitest'. */
function vitestNames(tokens: readonly Token[]): Map<string, 'test' | 'suite'> {
  const names = new Map<string, 'test' | 'suite'>();
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i]?.text !== 'import' || tokens[i]?.kind !== 'id') continue;
    let j = i + 1;
    if (tokens[j]?.text === 'type') continue; // `import type { … }`: no values
    if (tokens[j]?.kind === 'id' && tokens[j + 1]?.text === ',') j += 2; // a default import
    if (tokens[j]?.text !== '{') continue;
    const entries: { name: string; local: string }[] = [];
    let k = j + 1;
    while (k < tokens.length && tokens[k]?.text !== '}') {
      const name = tokens[k];
      if (name?.text === 'type' && tokens[k + 1]?.kind === 'id' && tokens[k + 1]?.text !== 'as') {
        // `type X` inside the braces: a type only
        k += 2;
        if (tokens[k]?.text === 'as') k += 2;
        if (tokens[k]?.text === ',') k += 1;
        continue;
      }
      if (name?.kind !== 'id' && name?.kind !== 'str') break;
      let local = name.text;
      if (tokens[k + 1]?.text === 'as' && tokens[k + 2]?.kind === 'id') {
        local = (tokens[k + 2] as Token).text;
        k += 2;
      }
      entries.push({ name: name.kind === 'str' ? (name.value ?? '') : name.text, local });
      k += 1;
      if (tokens[k]?.text === ',') k += 1;
    }
    if (tokens[k]?.text !== '}' || tokens[k + 1]?.text !== 'from') continue;
    const from = tokens[k + 2];
    if (from?.kind !== 'str' || from.value !== 'vitest') continue;
    for (const e of entries) {
      if (e.name === 'it' || e.name === 'test') names.set(e.local, 'test');
      if (e.name === 'describe' || e.name === 'suite') names.set(e.local, 'suite');
    }
  }
  return names;
}

/** One segment of a title: a literal, or null for a wildcard (any text). */
type Segment = string | null;

/** The title segments of the first argument tokens[from..to) of a test or describe call. */
function titleOf(tokens: readonly Token[], from: number, to: number, each: boolean): Segment[] {
  const only = to - from === 1 ? tokens[from] : undefined;
  let segments: Segment[];
  if (only?.kind === 'str' && typeof only.value === 'string') {
    segments = [only.value];
  } else if (only?.kind === 'tpl' && only.parts !== undefined && !only.parts.includes(null)) {
    segments = [];
    only.parts.forEach((p, i) => {
      if (i > 0) segments.push(null);
      segments.push(p);
    });
  } else {
    return [null];
  }
  if (!each) return segments;
  // .each / .for: Vitest formats %s, %d, %#, %$, %% … and $name / $a.b in the title.
  const out: Segment[] = [];
  for (const s of segments) {
    if (s === null) {
      out.push(null);
      continue;
    }
    const pieces = s.split(/%[\s\S]|\$[$\p{ID_Continue}.]+/u);
    pieces.forEach((p, i) => {
      if (i > 0) out.push(null);
      out.push(p);
    });
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** The full-name pattern of a test: any unknown suite prefix, the describe titles, the title. */
function patternOf(suites: readonly Segment[][], title: readonly Segment[]): RegExp {
  const part = (segments: readonly Segment[]): string =>
    segments.map((s) => (s === null ? '[\\s\\S]*' : escapeRegex(s))).join('');
  const chain = [...suites.map(part), part(title)].join(' > ');
  return new RegExp(`^(?:[\\s\\S]* > )?${chain}$`);
}

/** End index (exclusive) of the type arguments `<…>` starting at `j`, or null. */
function skipTypeArgs(
  tokens: readonly Token[],
  match: readonly number[],
  j: number,
): number | null {
  let depth = 0;
  for (let k = j; k < tokens.length; k += 1) {
    const t = tokens[k] as Token;
    if (t.kind === 'punct') {
      if (t.text === '<') depth += 1;
      else if (/^>+$/.test(t.text)) depth -= t.text.length;
      else if (t.text === '(' || t.text === '[' || t.text === '{') k = match[k] as number;
      else if ([')', ']', '}', ';'].includes(t.text)) return null;
    }
    if (depth === 0) return k + 1;
    if (depth < 0) return null;
  }
  return null;
}

type Call = {
  kind: 'test' | 'suite';
  start: number;
  /** Last token of the call, the `;` that ends it included for a test. */
  end: number;
  /** The argument list of the final call: tokens (open, close). */
  open: number;
  close: number;
  title: Segment[];
  /** Normalised text of the callee chain and the title (describe key). */
  head: string;
};

/** The call of `it` / `test` / `describe` / `suite` starting at token i, or null. */
function callAt(
  tokens: readonly Token[],
  match: readonly number[],
  i: number,
  kind: 'test' | 'suite',
  sep: Separator,
): Call | null {
  const prev = tokens[i - 1];
  if (prev !== undefined && ['.', '?.', 'function'].includes(prev.text)) return null;
  let j = i + 1;
  let each = false;
  let last: 'member' | 'call' | 'tag' | null = null;
  let open = -1;
  let close = -1;
  for (;;) {
    const t = tokens[j];
    if (t === undefined) break;
    if (t.text === '.' && tokens[j + 1]?.kind === 'id') {
      const name = (tokens[j + 1] as Token).text;
      // `it.extend({…})` / `it.scoped({…})` define fixtures, not a test: they stay in the shared
      // rest, so a change to them makes every test of the file changed.
      if (name === 'extend' || name === 'scoped') return null;
      if (name === 'each' || name === 'for') each = true;
      last = 'member';
      j += 2;
    } else if (t.kind === 'punct' && t.text === '<') {
      const k = skipTypeArgs(tokens, match, j);
      if (k === null || (tokens[k]?.text !== '(' && tokens[k]?.kind !== 'tpl')) break;
      j = k;
    } else if (t.kind === 'punct' && t.text === '(') {
      open = j;
      close = match[j] as number;
      last = 'call';
      j = close + 1;
    } else if (t.kind === 'tpl' && last === 'member' && each) {
      last = 'tag';
      j += 1;
    } else {
      break;
    }
  }
  if (last !== 'call') return null;
  // The first argument of the final call: up to the first top-level comma.
  let to = open + 1;
  while (to < close && tokens[to]?.text !== ',') {
    const t = tokens[to] as Token;
    to = t.text === '(' || t.text === '[' || t.text === '{' ? (match[to] as number) + 1 : to + 1;
  }
  const end = kind === 'test' && tokens[close + 1]?.text === ';' ? close + 1 : close;
  return {
    kind,
    start: i,
    end,
    open,
    close,
    title: titleOf(tokens, open + 1, to, each),
    head: joinTokens(tokens, i, to - 1, sep),
  };
}

export type TestBlock = {
  /** Matches the full names (describe > … > title) the block can produce. */
  pattern: RegExp;
  /** Readable title (wildcards shown as `*`), for notes. */
  title: string;
  /** Describe keys (position and header) and normalised text: equal keys are the same test. */
  key: string;
};

export type ParsedTestFile = {
  /** Normalised text of everything outside the test blocks. */
  shared: string;
  blocks: TestBlock[];
};

/** Test blocks and shared rest of a rule-test file (see the header); throws TestParseError. */
export function parseTestFile(source: string): ParsedTestFile {
  const tokens = tokenize(source);
  const match = matchBrackets(tokens);
  const names = vitestNames(tokens);
  const sep = separators(source, tokens);
  const suites: Call[] = [];
  const tests: Call[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    const kind = t.kind === 'id' ? names.get(t.text) : undefined;
    if (kind === undefined) continue;
    const call = callAt(tokens, match, i, kind, sep);
    if (call === null) continue;
    if (kind === 'suite') {
      suites.push(call);
    } else {
      tests.push(call);
      i = call.end; // outermost test calls only
    }
  }
  const inBlock = new Array<boolean>(tokens.length).fill(false);
  for (const c of tests) for (let k = c.start; k <= c.end; k += 1) inBlock[k] = true;
  let shared = '';
  let first = true;
  let pendingNl = false;
  // anchor[k]: how many shared tokens come before token k (where in the shared rest a block sits).
  const anchor = new Array<number>(tokens.length).fill(0);
  let sharedCount = 0;
  tokens.forEach((t, k) => {
    anchor[k] = sharedCount;
    if (inBlock[k]) {
      pendingNl ||= t.nl;
      return;
    }
    if (first) shared += t.text;
    else if (pendingNl || t.nl) shared += `\n${t.text}`;
    else shared += `${inBlock[k - 1] === true ? ' ' : sep(k)}${t.text}`;
    first = false;
    pendingNl = false;
    sharedCount += 1;
  });
  const blocks = tests.map((c) => {
    const around = suites.filter((s) => s.open < c.start && c.start < s.close);
    const show = (segments: readonly Segment[]): string =>
      segments.map((s) => (s === null ? '*' : s)).join('');
    return {
      pattern: patternOf(
        around.map((s) => s.title),
        c.title,
      ),
      title: [...around.map((s) => show(s.title)), show(c.title)].join(' > '),
      // Where the block sits in the shared rest (its anchor: the shared tokens before it), its
      // describes (position among the file's describes and header) and its text: a block moved
      // into another describe, loop, branch or function — also between two with the same
      // header — is a different block (Codex review r1 / r2, S2).
      key: [
        String(anchor[c.start]),
        around.map((s) => `${suites.indexOf(s)}:${s.head}`).join('\u0001'),
        joinTokens(tokens, c.start, c.end, sep),
      ].join('\u0000'),
    };
  });
  return { shared, blocks };
}

export type ComparedBlock = {
  pattern: RegExp;
  title: string;
  /** False only when the block is the same as at the base (see the header). */
  changed: boolean;
};

export type FileComparison =
  { whole: true; reason: string } | { whole: false; blocks: ComparedBlock[] };

/** Positions (in `seq`) of one longest strictly increasing subsequence of `seq`. */
function longestIncreasing(seq: readonly number[]): Set<number> {
  const best = seq.map(() => 1);
  const from = seq.map(() => -1);
  let top = -1;
  for (let i = 0; i < seq.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (
        (seq[j] as number) < (seq[i] as number) &&
        (best[j] as number) + 1 > (best[i] as number)
      ) {
        best[i] = (best[j] as number) + 1;
        from[i] = j;
      }
    }
    if (top < 0 || (best[i] as number) > (best[top] as number)) top = i;
  }
  const keep = new Set<number>();
  for (let i = top; i >= 0; i = from[i] as number) keep.add(i);
  return keep;
}

/**
 * Compares the base and head text of a rule-test file that existed at the base (see the header):
 * either the whole file counts as changed (with the reason), or each head block says whether it
 * changed.
 */
export function compareTestFile(base: string, head: string): FileComparison {
  let before: ParsedTestFile;
  let after: ParsedTestFile;
  try {
    before = parseTestFile(base);
  } catch (err) {
    return { whole: true, reason: `the file at the base cannot be read as tests (${String(err)})` };
  }
  try {
    after = parseTestFile(head);
  } catch (err) {
    return { whole: true, reason: `the file cannot be read as tests (${String(err)})` };
  }
  if (before.shared !== after.shared) {
    return {
      whole: true,
      reason:
        'code outside the tests changed (imports, helpers, hooks, top-level tables or describe titles)',
    };
  }
  const count = (blocks: readonly TestBlock[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const b of blocks) m.set(b.key, (m.get(b.key) ?? 0) + 1);
    return m;
  };
  const baseCount = count(before.blocks);
  const headCount = count(after.blocks);
  const baseIndex = new Map(before.blocks.map((b, i) => [b.key, i]));
  // Head blocks with exactly one counterpart, in head order, and their base positions.
  const paired: number[] = [];
  const pairedBase: number[] = [];
  after.blocks.forEach((b, i) => {
    if (baseCount.get(b.key) === 1 && headCount.get(b.key) === 1) {
      paired.push(i);
      pairedBase.push(baseIndex.get(b.key) as number);
    }
  });
  const inOrder = longestIncreasing(pairedBase);
  const unchanged = new Set(paired.filter((_, k) => inOrder.has(k)));
  return {
    whole: false,
    blocks: after.blocks.map((b, i) => ({
      pattern: b.pattern,
      title: b.title,
      changed: !unchanged.has(i),
    })),
  };
}

/**
 * Whether a report test (its full name) is exempt from the red requirement: exactly one block's
 * pattern matches it and that block is unchanged.
 */
export function unchangedTest(fullName: string, blocks: readonly ComparedBlock[]): boolean {
  if (fullName === '') return false;
  const hits = blocks.filter((b) => b.pattern.test(fullName));
  return hits.length === 1 && hits[0]?.changed === false;
}

const CODE_FILE = /\.[cm]?[jt]sx?$/;

function dirOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Repo-relative POSIX path of `spec` (./ or ../) seen from the module at `from`, or null. */
function resolveRelative(from: string, spec: string): string | null {
  const parts = dirOf(from) === '' ? [] : dirOf(from).split('/');
  for (const p of spec.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(p);
    }
  }
  return parts.join('/');
}

/** The tokens with those inside template expressions, depth first. */
function flatten(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    out.push(t);
    if (t.inner !== undefined) out.push(...flatten(t.inner));
  }
  return out;
}

/** Calls that load files / modules by a computed name (never resolved: always dynamic). */
const DYNAMIC_ACCESS = new Set(['glob', 'globSync', 'require', 'createRequire']);
/** Calls that list a directory: resolved statically when they can be (listedDirectories). */
const LISTING = new Set(['readdir', 'readdirSync', 'opendir', 'opendirSync']);

/** The reason a module may load files it does not name, or null (directory listings aside). */
function dynamicAccess(code: readonly Token[]): string | null {
  const tokens = flatten(code);
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind !== 'id') continue;
    if (DYNAMIC_ACCESS.has(t.text)) return `it uses ${t.text}`;
    if (t.text === 'glob' && tokens[i - 1]?.text === '.') return 'it uses import.meta.glob';
    if (t.text === 'import' && tokens[i + 1]?.text === '(') {
      const arg = tokens[i + 2];
      const literal =
        arg !== undefined &&
        (arg.kind === 'str' || (arg.kind === 'tpl' && (arg.parts?.length ?? 0) === 1)) &&
        (tokens[i + 3]?.text === ')' || tokens[i + 3]?.text === ',');
      if (!literal) return 'it imports a module by a computed name';
    }
  }
  return null;
}

/** Repo-relative normalised path of `dir` + `spec` (POSIX segments), or null when it escapes. */
function joinPath(dir: string, spec: string): string | null {
  const parts = dir === '' ? [] : dir.split('/');
  for (const p of spec.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(p);
    }
  }
  return parts.join('/');
}

/** Index of the bracket that closes the one at `open`, or -1. */
function closeOf(ts: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < ts.length; i += 1) {
    const text = ts[i]?.kind === 'punct' ? (ts[i] as Token).text : '';
    if (text === '(' || text === '[' || text === '{') depth += 1;
    else if (text === ')' || text === ']' || text === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The top-level arguments between ts[open] === '(' and its close: [start, end) index pairs. */
function argsOf(ts: readonly Token[], open: number): [number, number][] | null {
  const close = closeOf(ts, open);
  if (close < 0) return null;
  const out: [number, number][] = [];
  let start = open + 1;
  let depth = 0;
  for (let i = open + 1; i < close; i += 1) {
    const text = ts[i]?.kind === 'punct' ? (ts[i] as Token).text : '';
    if (text === '(' || text === '[' || text === '{') depth += 1;
    else if (text === ')' || text === ']' || text === '}') depth -= 1;
    else if (text === ',' && depth === 0) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  if (start < close) out.push([start, close]);
  return out;
}

/**
 * A path value resolved statically: `url` marks `new URL(…)` / import.meta.url semantics; `raw`
 * keeps the literal text a parameter was called with, for `new URL(p, base)` and join segments.
 * A bare literal has no `path`: a file-system path is relative to the working directory, which
 * is not known (Codex review r1, S2), so it resolves only as a URL spec or a join segment.
 */
type PathValue = { path: string | null; url: boolean; raw?: string };

/** The static string of a literal or expression-free template token, or null. */
function staticString(t: Token | undefined): string | null {
  if (t === undefined) return null;
  if (t.kind === 'str') return typeof t.value === 'string' ? t.value : null;
  if (t.kind === 'tpl' && t.parts?.length === 1) return t.parts[0] ?? null;
  return null;
}

/**
 * Resolves the path expression at ts[i] (CT-06r), given the module's path and the constants
 * already resolved: a literal (only its text: as a file-system path it is relative to the
 * working directory, which is unknown, so it resolves only as a URL spec or a join segment),
 * `__dirname`,
 * `import.meta.dirname`, `import.meta.url`, a known constant, `path.join` / `join` /
 * `path.resolve` / `resolve` of a resolved first argument and literal segments, `path.dirname` /
 * `dirname` of a resolved value, `fileURLToPath(…)`, `new URL(literal, resolved)`, and
 * parentheses around any of these. Anything else is null (not resolved). `end` is the index after
 * the expression when resolved.
 */
function resolveExpr(
  ts: readonly Token[],
  i: number,
  modulePath: string,
  env: ReadonlyMap<string, PathValue>,
): { value: PathValue | null; end: number } {
  const none = { value: null, end: i };
  const t = ts[i];
  if (t === undefined) return none;
  const after = (value: PathValue | null, end: number) => {
    // `.href` / `.pathname` of a URL value: the same path.
    if (
      value !== null &&
      ts[end]?.text === '.' &&
      /^(href|pathname)$/.test(ts[end + 1]?.text ?? '')
    ) {
      return { value, end: end + 2 };
    }
    return { value, end };
  };
  const literal = staticString(t);
  if (literal !== null) return { value: { path: null, url: false, raw: literal }, end: i + 1 };
  // The literal text a parameter or constant stands for (a call like list('./x')).
  const rawOf = (k: number): string | null =>
    staticString(ts[k]) ??
    (ts[k]?.kind === 'id' ? (env.get((ts[k] as Token).text)?.raw ?? null) : null);
  if (t.kind === 'punct' && t.text === '(') {
    const inner = resolveExpr(ts, i + 1, modulePath, env);
    if (inner.value === null || ts[inner.end]?.text !== ')') return none;
    return after(inner.value, inner.end + 1);
  }
  if (t.kind !== 'id') return none;
  if (t.text === '__dirname') return { value: { path: dirOf(modulePath), url: false }, end: i + 1 };
  if (t.text === 'import' && ts[i + 1]?.text === '.' && ts[i + 2]?.text === 'meta') {
    if (ts[i + 3]?.text === '.' && ts[i + 4]?.text === 'dirname') {
      return { value: { path: dirOf(modulePath), url: false }, end: i + 5 };
    }
    if (ts[i + 3]?.text === '.' && ts[i + 4]?.text === 'url') {
      return { value: { path: modulePath, url: true }, end: i + 5 };
    }
    return none;
  }
  // `new URL(literal, base)`: the literal is resolved against the directory of the base file (or
  // the base directory when it ends with "/").
  if (t.text === 'new' && ts[i + 1]?.text === 'URL' && ts[i + 2]?.text === '(') {
    const args = argsOf(ts, i + 2);
    if (args === null || args.length !== 2) return none;
    const [specArg, baseArg] = args as [[number, number], [number, number]];
    const spec = specArg[1] - specArg[0] === 1 ? rawOf(specArg[0]) : null;
    const base = resolveExpr(ts, baseArg[0], modulePath, env);
    if (spec === null || base.value?.path == null || base.end !== baseArg[1]) return none;
    if (spec.startsWith('/') || /^[a-z]+:/i.test(spec)) return none;
    const from = base.value.path.endsWith('/')
      ? base.value.path.slice(0, -1)
      : dirOf(base.value.path);
    const joined = joinPath(from, spec.replace(/[?#].*$/, ''));
    if (joined === null) return none;
    return after(
      { path: spec.endsWith('/') ? `${joined}/` : joined, url: true },
      closeOf(ts, i + 2) + 1,
    );
  }
  // `path.x(…)` or a bare `x(…)` (x = join, resolve, dirname); `fileURLToPath(…)`.
  let fn = t.text;
  let open = i + 1;
  if ((fn === 'path' || fn === 'node') && ts[i + 1]?.text === '.' && ts[i + 2]?.kind === 'id') {
    fn = (ts[i + 2] as Token).text;
    open = i + 3;
  }
  if (
    ts[open]?.text === '(' &&
    (fn === 'join' || fn === 'resolve' || fn === 'dirname' || fn === 'fileURLToPath')
  ) {
    const args = argsOf(ts, open);
    if (args === null || args.length === 0) return none;
    const end = closeOf(ts, open) + 1;
    const first = args[0] as [number, number];
    const head = resolveExpr(ts, first[0], modulePath, env);
    if (head.value?.path == null || head.end !== first[1]) return none;
    const headPath = head.value.path.endsWith('/') ? head.value.path.slice(0, -1) : head.value.path;
    if (fn === 'fileURLToPath') {
      return args.length === 1 ? after({ path: headPath, url: false }, end) : none;
    }
    if (fn === 'dirname') {
      return args.length === 1 ? after({ path: dirOf(headPath), url: false }, end) : none;
    }
    let path: string | null = headPath;
    for (const [s, e] of args.slice(1)) {
      const segment = e - s === 1 ? rawOf(s) : null;
      if (segment === null || segment.startsWith('/')) return none;
      path = joinPath(path, segment);
      if (path === null) return none;
    }
    return after({ path, url: false }, end);
  }
  const known = env.get(t.text);
  if (known !== undefined && ts[i + 1]?.text !== '(') return after(known, i + 1);
  return none;
}

/** A function of the module: its name, parameter names (null: not a plain name) and body range. */
type Fn = { name: string; params: (string | null)[]; bodyStart: number; bodyEnd: number };

/** Parameter names of the list between ts[open] === '(' and its close. */
function paramNames(ts: readonly Token[], open: number): (string | null)[] | null {
  const args = argsOf(ts, open);
  if (args === null) return null;
  return args.map(([s]) => (ts[s]?.kind === 'id' ? (ts[s] as Token).text : null));
}

/** The named functions of the module (declarations and `const f = (…) => {…}`). */
function functionsOf(ts: readonly Token[]): Fn[] {
  const out: Fn[] = [];
  for (let i = 0; i < ts.length; i += 1) {
    const t = ts[i] as Token;
    if (t.kind !== 'id') continue;
    let name: string | null = null;
    let open = -1;
    if (t.text === 'function' && ts[i + 1]?.kind === 'id' && ts[i + 2]?.text === '(') {
      name = (ts[i + 1] as Token).text;
      open = i + 2;
    } else if (
      (t.text === 'const' || t.text === 'let' || t.text === 'var') &&
      ts[i + 1]?.kind === 'id' &&
      ts[i + 2]?.text === '='
    ) {
      let j = i + 3;
      if (ts[j]?.text === 'async') j += 1;
      if (ts[j]?.text === 'function') {
        j += 1;
        if (ts[j]?.kind === 'id') j += 1;
      }
      if (ts[j]?.text === '(') {
        name = (ts[i + 1] as Token).text;
        open = j;
      }
    }
    if (name === null || open < 0) continue;
    const close = closeOf(ts, open);
    if (close < 0) continue;
    const params = paramNames(ts, open);
    if (params === null) continue;
    // The body: `{` after the parameters (past a return type or `=>`), or an expression body.
    let j = close + 1;
    while (j < ts.length && ts[j]?.text !== '{' && ts[j]?.text !== '=>' && !(ts[j] as Token).nl)
      j += 1;
    if (ts[j]?.text === '=>') j += 1;
    if (ts[j]?.text !== '{') continue;
    const bodyEnd = closeOf(ts, j);
    if (bodyEnd < 0) continue;
    out.push({ name, params, bodyStart: j, bodyEnd });
  }
  return out;
}

/**
 * The directories a module lists (readdir, readdirSync, opendir, opendirSync; CT-06r, after
 * B1-12g): each listing's directory is resolved statically (resolveExpr) through the module's
 * constants; a listing inside a named function whose directory comes from a parameter is
 * resolved at every call of that function outside its own body (a recursive call inside it
 * walks the same tree). `dirs` are repo-relative; `unresolved` says why a listing could not be
 * resolved (the module is then treated as able to read anything, as before).
 */
export function listedDirectories(
  code: readonly Token[],
  modulePath: string,
): { dirs: string[]; unresolved: string | null } {
  const ts = code;
  // Constants: `const NAME = <path expression>` whose initialiser is the whole expression (a
  // `.replace(…)`, an operator or anything else after it leaves the name unknown; Codex review
  // r1, S2); two passes for a forward reference.
  const env = new Map<string, PathValue>();
  const initialiserEnds = (k: number): boolean =>
    k >= ts.length || ts[k]?.text === ';' || ts[k]?.text === ',' || (ts[k] as Token).nl;
  // A name declared twice (a same-named local in another scope) or assigned anywhere outside its
  // declaration is no constant: scopes are not tracked, so it stays unknown (Codex review r2 and
  // r3, S2).
  const declared = new Map<string, number>();
  const unknown = new Set<string>();
  for (let i = 0; i + 2 < ts.length; i += 1) {
    const t = ts[i] as Token;
    const name = ts[i + 1];
    if (name?.kind !== 'id') continue;
    if (t.kind === 'id' && (t.text === 'const' || t.text === 'let' || t.text === 'var')) {
      declared.set(name.text, (declared.get(name.text) ?? 0) + 1);
    }
  }
  for (const [name, count] of declared) if (count > 1) unknown.add(name);
  for (let i = 1; i < ts.length; i += 1) {
    const t = ts[i] as Token;
    if (t.kind !== 'id' || !declared.has(t.text) || ts[i + 1]?.text !== '=') continue;
    const before = ts[i - 1]?.text;
    if (before === 'const' || before === 'let' || before === 'var' || before === '.') continue;
    unknown.add(t.text);
  }
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i + 3 < ts.length; i += 1) {
      const t = ts[i] as Token;
      if (t.kind !== 'id' || (t.text !== 'const' && t.text !== 'let' && t.text !== 'var')) continue;
      const name = ts[i + 1];
      if (name?.kind !== 'id' || ts[i + 2]?.text !== '=' || unknown.has(name.text)) continue;
      const r = resolveExpr(ts, i + 3, modulePath, env);
      if (r.value !== null && initialiserEnds(r.end)) env.set(name.text, r.value);
    }
  }
  const fns = functionsOf(ts);
  // The scope at a position: the constants minus the parameters of every function enclosing it
  // (a parameter shadows a same-named constant; Codex review r2, S2).
  const scopeAt = (k: number): Map<string, PathValue> => {
    const scope = new Map(env);
    for (const f of fns) {
      if (f.bodyStart < k && k < f.bodyEnd)
        for (const p of f.params) if (p !== null) scope.delete(p);
    }
    return scope;
  };
  const dirs = new Set<string>();
  let unresolved: string | null = null;
  const note = (what: string): void => {
    if (unresolved === null) unresolved = what;
  };
  // A listing inside a template expression is not followed.
  for (const t of flatten(ts)) {
    if (t.kind === 'tpl') {
      for (const x of flatten(t.inner ?? [])) {
        if (x.kind === 'id' && LISTING.has(x.text))
          note(`it uses ${x.text} inside a template expression`);
      }
    }
  }
  for (let i = 0; i < ts.length; i += 1) {
    const t = ts[i] as Token;
    if (t.kind !== 'id' || !LISTING.has(t.text) || ts[i + 1]?.text !== '(') continue;
    const call = `${t.text}(…)`;
    const args = argsOf(ts, i + 1);
    const first = args?.[0];
    if (first === undefined) {
      note(`it uses ${call} without a directory`);
      continue;
    }
    const resolveWith = (scope: ReadonlyMap<string, PathValue>): string | null => {
      const r = resolveExpr(ts, first[0], modulePath, scope);
      if (r.value?.path == null || r.end !== first[1]) return null;
      return r.value.path.endsWith('/') ? r.value.path.slice(0, -1) : r.value.path;
    };
    const direct = resolveWith(scopeAt(i));
    if (direct !== null) {
      dirs.add(direct);
      continue;
    }
    // Inside a named function: resolve the directory at each call outside the function.
    const inside = fns.filter((f) => f.bodyStart < i && i < f.bodyEnd);
    const fn = inside.length === 0 ? undefined : inside[inside.length - 1];
    if (fn === undefined || fn.params.every((p) => p === null)) {
      note(`it uses ${call} on a directory that cannot be resolved statically`);
      continue;
    }
    // The parameter the listing reads (the listed expression must be that parameter itself, or
    // a resolvable expression over it is handled by resolveWith below).
    const listedParam =
      first[1] - first[0] === 1 && ts[first[0]]?.kind === 'id'
        ? (ts[first[0]] as Token).text
        : null;
    const paramIndex = listedParam === null ? -1 : fn.params.indexOf(listedParam);
    // A recursive call stays in the listed tree only when its argument is the parameter itself,
    // `join(param, …)` / `path.join(param, …)`, or a local const defined as one of those; anything
    // else (dirname(param), a sibling) may leave the tree and is not resolved (Codex review r3,
    // S2).
    const staysInside = (a: [number, number]): boolean => {
      if (paramIndex < 0) return false;
      const isJoinOfParam = (from: number, to: number): boolean => {
        let j = from;
        if (ts[j]?.text === 'path' && ts[j + 1]?.text === '.') j += 2;
        if (ts[j]?.text !== 'join' || ts[j + 1]?.text !== '(') return false;
        const inner = argsOf(ts, j + 1);
        const close = closeOf(ts, j + 1);
        if (inner === null || inner.length === 0 || close !== to - 1) return false;
        const head = inner[0] as [number, number];
        return head[1] - head[0] === 1 && ts[head[0]]?.text === listedParam;
      };
      if (a[1] - a[0] === 1 && ts[a[0]]?.kind === 'id') {
        const id = (ts[a[0]] as Token).text;
        if (id === listedParam) return true;
        // A local `const id = join(param, …)` inside the function body.
        for (let j = fn.bodyStart; j < fn.bodyEnd - 3; j += 1) {
          if (ts[j]?.text === 'const' && ts[j + 1]?.text === id && ts[j + 2]?.text === '=') {
            // The initialiser: up to a `;`, `,` or line break outside brackets.
            let end = j + 3;
            let depth = 0;
            while (end < fn.bodyEnd) {
              const text = ts[end]?.kind === 'punct' ? (ts[end] as Token).text : '';
              if (depth === 0 && end > j + 3 && initialiserEnds(end)) break;
              if (text === '(' || text === '[' || text === '{') depth += 1;
              else if (text === ')' || text === ']' || text === '}') depth -= 1;
              end += 1;
            }
            return isJoinOfParam(j + 3, end);
          }
        }
        return false;
      }
      return isJoinOfParam(a[0], a[1]);
    };
    let calls = 0;
    let failed = false;
    for (let k = 0; k < ts.length; k += 1) {
      const c = ts[k] as Token;
      if (c.kind !== 'id' || c.text !== fn.name || ts[k + 1]?.text !== '(') continue;
      if (ts[k - 1]?.text === 'function') continue; // the declaration itself
      if (fn.bodyStart <= k && k <= fn.bodyEnd) {
        const rarg = (argsOf(ts, k + 1) ?? [])[paramIndex];
        if (rarg !== undefined && staysInside(rarg)) continue; // a recursive walk of the same tree
        failed = true;
        break;
      }
      calls += 1;
      const cargs = argsOf(ts, k + 1) ?? [];
      const callScope = scopeAt(k);
      const scope = new Map(callScope);
      fn.params.forEach((p, idx) => {
        const a = cargs[idx];
        if (p === null || a === undefined) return;
        const r = resolveExpr(ts, a[0], modulePath, callScope);
        if (r.value !== null && r.end === a[1]) scope.set(p, r.value);
        else scope.delete(p);
      });
      const dir = resolveWith(scope);
      if (dir === null) {
        failed = true;
        break;
      }
      dirs.add(dir);
    }
    if (calls === 0 || failed) {
      note(`it uses ${call} in ${fn.name}() on a directory that cannot be resolved statically`);
    }
  }
  return { dirs: [...dirs].sort(), unresolved };
}

/** A string literal (or the static parts of a template) with its offsets in the module text. */
export type Literal = { text: string; start: number; end: number };

/**
 * An import of a module (CT-06w): the specifier as written, where its string literal sits in the
 * module text (the quotes included) and the repository file it names once resolved — or null with
 * `why` when it cannot be resolved (mayReadSupport then judges the literal as before).
 */
export type ModuleImport = {
  spec: string;
  start: number;
  end: number;
  resolved: string | null;
  why: string | null;
};

export type Module = {
  path: string;
  text: string;
  /** String contents (literals, static template parts); null when the text cannot be tokenized. */
  literals: Literal[] | null;
  /** Why the module may load files it does not name (dynamicAccess), or null. */
  dynamic: string | null;
  /** The directories it lists, resolved statically (CT-06r); [] when it lists none. */
  lists: string[];
  /** Its import specifiers resolved to repository paths (CT-06w); [] when it cannot be tokenized. */
  imports: ModuleImport[];
  /**
   * Why the module may read files in a way the rules here do not see (CT-06w, Codex review r4):
   * a file-system API, `import.meta`, a module mock, a listing, a dynamic load; null when none.
   */
  opaque: string | null;
  /**
   * The module is closed (CT-06w): it is not opaque and every relative / `#` import of it
   * resolves to a closed module of the closure or to a file outside the test code. Only an
   * import of a closed module may be skipped by the name rules of mayReadSupport.
   */
  closed: boolean;
};

type Reader = (path: string) => string | null;

/** The string literals of a module with their offsets (nested template parts too). */
function literalsOf(tokens: readonly Token[]): Literal[] {
  const out: Literal[] = [];
  for (const t of flatten(tokens)) {
    const start = t.start ?? 0;
    const end = start + t.text.length;
    if (t.kind === 'str' && typeof t.value === 'string') out.push({ text: t.value, start, end });
    if (t.kind === 'tpl')
      for (const p of t.parts ?? []) if (p !== null) out.push({ text: p, start, end });
  }
  return out;
}

/** Identifiers of file-system access, module loading by path and process state (fileAccess). */
const FILE_ACCESS = new Set([
  'readFileSync',
  'readFile',
  'readdirSync',
  'readdir',
  'opendirSync',
  'opendir',
  'createReadStream',
  'openSync',
  'statSync',
  'lstatSync',
  'existsSync',
  'accessSync',
  'realpathSync',
  'readlinkSync',
  'fileURLToPath',
  'pathToFileURL',
  '__dirname',
  '__filename',
  'createRequire',
  'require',
  'glob',
  'globSync',
  'cwd',
]);
const FILE_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const MOCKING = new Set([
  'mock',
  'doMock',
  'unmock',
  'doUnmock',
  'importActual',
  'importMock',
  'hoisted',
]);

/**
 * Why a module may read files in a way the rules of mayReadSupport do not see (CT-06w, Codex
 * review r4): a file-system API or a path built from `import.meta` / `__dirname`, a module mock
 * (Vitest redirects it to `__mocks__`), `require` / `glob`. Null when it uses none of them.
 */
function fileAccess(code: readonly Token[]): string | null {
  const tokens = flatten(code);
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind === 'id' && FILE_ACCESS.has(t.text)) return `it uses ${t.text}`;
    if (t.kind === 'str' && typeof t.value === 'string' && FILE_MODULES.has(t.value)) {
      return `it uses ${t.value}`;
    }
    if (
      t.kind === 'id' &&
      t.text === 'meta' &&
      tokens[i - 1]?.text === '.' &&
      tokens[i - 2]?.text === 'import'
    ) {
      return 'it uses import.meta';
    }
    if (
      t.kind === 'id' &&
      MOCKING.has(t.text) &&
      tokens[i - 1]?.text === '.' &&
      tokens[i - 2]?.text === 'vi'
    ) {
      return `it uses vi.${t.text}`;
    }
  }
  return null;
}

/**
 * The module specifiers of a module (CT-06w): the string after `from` (`import … from`,
 * `export … from`), after `import` (`import 'x'`) and the single literal of `import('x')` — in
 * the module's own token list only (the expressions of a template are lexed into one list, so
 * `${from}${'./x'}` would look like an import there; Codex review r2), the keyword not a member
 * (`reader.import('x')` is a method call; Codex review r1) and, for `from`, preceded by what an
 * import or export clause ends with (`}`, `*` or a name). A template specifier, `vi.mock(…)`,
 * `new URL(…)` and `require` are not imports here: their literals keep the name rules of
 * mayReadSupport.
 */
function importSpecifiers(
  tokens: readonly Token[],
): { spec: string; start: number; end: number }[] {
  const out: { spec: string; start: number; end: number }[] = [];
  const member = (t: Token | undefined): boolean => t?.text === '.' || t?.text === '?.';
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind !== 'str' || typeof t.value !== 'string' || t.start === undefined) continue;
    const prev = tokens[i - 1];
    const before = tokens[i - 2];
    const next = tokens[i + 1]?.text;
    let isImport = false;
    if (prev?.kind === 'id' && prev.text === 'from') {
      isImport =
        before !== undefined &&
        (before.kind === 'id' || before.text === '}' || before.text === '*') &&
        !member(tokens[i - 3]);
    } else if (prev?.kind === 'id' && prev.text === 'import') {
      isImport = !member(before);
    } else if (prev?.kind === 'punct' && prev.text === '(') {
      // `vi.mock(import('x'))` is a mock, not a load (Vitest redirects it; Codex review r4).
      const mocked =
        tokens[i - 3]?.text === '(' &&
        tokens[i - 4]?.kind === 'id' &&
        MOCKING.has((tokens[i - 4] as Token).text) &&
        tokens[i - 5]?.text === '.';
      isImport =
        before?.kind === 'id' &&
        before.text === 'import' &&
        !member(tokens[i - 3]) &&
        !mocked &&
        (next === ')' || next === ',');
    }
    if (isImport) out.push({ spec: t.value, start: t.start, end: t.start + t.text.length });
  }
  return out;
}

/** The files the closure follows for a relative literal (conservative: every spelling). */
function candidatesOf(target: string): string[] {
  return [target, target.replace(/\.js$/, '.ts'), `${target}.ts`, `${target}/index.ts`];
}

/**
 * What a repository path is (CT-06w): a regular file, a directory, absent, or `other` — a
 * symbolic link, a submodule, a path whose spelling is not the tree's (a directory link or a
 * case alias in a work tree), anything whose identity is not certain (Codex reviews r1, r2). An
 * import never resolves through `other`.
 */
export type PathKind = 'file' | 'dir' | 'absent' | 'other';

/** How the closure sees files: `read` the text of a path (null: none) and the kind of a path. */
type Files = { read: Reader; kind: (path: string) => PathKind };

/**
 * The nearest file called `name` at or above `dir`: its directory and text — or the reason it
 * cannot be told: a `name` on the way that is not a regular file (a symbolic link; Codex review
 * r2) stops the search, since the runtime would read it.
 */
function nearestFile(
  dir: string,
  name: string,
  files: Files,
): { dir: string; text: string } | { why: string } | null {
  for (let d = dir; ; d = dirOf(d)) {
    const path = d === '' ? name : `${d}/${name}`;
    const kind = files.kind(path);
    if (kind === 'file') {
      const text = files.read(path);
      if (text !== null) return { dir: d, text };
    }
    if (kind === 'other' || kind === 'dir') return { why: `${path} is not a regular file` };
    if (d === '') return null;
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The key of `keys` that matches `spec`: the key itself, or the single key with one `*` whose
 * prefix and suffix enclose a non-empty rest — and that rest. Undecided (`ambiguous`): two
 * matching patterns (Node and Vite's resolver rank them differently; Codex review r2), a folder
 * key (`#x/`) that covers the specifier, a pattern with a regular-expression character (Vite's
 * resolver builds an unescaped RegExp from the key, so `#k.t.*` also matches `#kit.ts`; Codex
 * review r3), or a pattern that such a RegExp matches although its prefix and suffix do not.
 */
function matchKey(
  keys: readonly string[],
  spec: string,
): { key: string; star: string } | 'ambiguous' | null {
  const hits: { key: string; star: string }[] = [];
  let loose = 0;
  for (const key of keys) {
    const star = key.indexOf('*');
    if (star < 0) {
      if (key === spec) return { key, star: '' };
      if (key.endsWith('/') && spec.startsWith(key)) return 'ambiguous';
      continue;
    }
    if (key.indexOf('*', star + 1) >= 0) return 'ambiguous';
    try {
      if (new RegExp(`^${key.replace('*', '(.*)')}$`).test(spec)) loose += 1;
    } catch {
      return 'ambiguous';
    }
    const pre = key.slice(0, star);
    const post = key.slice(star + 1);
    if (spec.length <= pre.length + post.length || !spec.startsWith(pre) || !spec.endsWith(post)) {
      continue;
    }
    if (/[.+?^${}()|[\]\\]/.test(key)) return 'ambiguous';
    hits.push({ key, star: spec.slice(pre.length, spec.length - post.length) });
  }
  if (hits.length > 1 || loose > hits.length) return 'ambiguous';
  return hits[0] ?? null;
}

type Resolution = { resolved: string | null; why: string | null };

const unresolved = (why: string): Resolution => ({ resolved: null, why });
const resolvedAs = (path: string): Resolution => ({ resolved: path, why: null });

/** Vite's `resolve.extensions`, in its order. */
const RESOLVE_EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];

/**
 * The file a repository path stands for as a module (CT-06w; the rules Vite applies, and only
 * where one file is certain, Codex reviews r1 and r2): the path itself when it is a regular
 * file; else, for a `.js` path, the `.ts` file (TypeScript lets `./x.js` name it) when the `.js`
 * path is absent; else, for a path without an extension, the single file among path + Vite's
 * extensions, else the single `path/index` + extension when the path is a directory without a
 * package.json. A candidate of kind `other` on the way (a symbolic link the runtime may follow),
 * two candidates, a package directory or nothing at all are unresolved.
 */
function resolveModuleFile(target: string, files: Files): Resolution {
  const kind = files.kind(target);
  if (kind === 'file') return resolvedAs(target);
  if (kind === 'other') return unresolved(`${target} is not a regular file`);
  if (/\.[A-Za-z0-9]+$/.test(baseName(target))) {
    if (kind === 'dir') return unresolved(`${target} is a directory`);
    if (target.endsWith('.js')) {
      const ts = target.replace(/\.js$/, '.ts');
      const tsKind = files.kind(ts);
      if (tsKind === 'file') return resolvedAs(ts);
      if (tsKind !== 'absent') return unresolved(`${ts} is not a regular file`);
    }
    return unresolved(`no file at ${target}`);
  }
  const certain = (paths: string[]): string[] | string => {
    const found: string[] = [];
    for (const p of paths) {
      const k = files.kind(p);
      if (k === 'file') found.push(p);
      else if (k !== 'absent') return `${p} is not a regular file`;
    }
    return found;
  };
  const own = certain(RESOLVE_EXTENSIONS.map((e) => `${target}${e}`));
  if (typeof own === 'string') return unresolved(own);
  if (own.length > 1) return unresolved(`${target} is ambiguous (${own.join(', ')})`);
  if (kind === 'absent') {
    return own.length === 1 ? resolvedAs(own[0] as string) : unresolved(`no file at ${target}`);
  }
  // A directory: its package.json decides, else its index file — unless a file competes.
  const pkg = files.kind(`${target}/package.json`);
  if (pkg !== 'absent')
    return unresolved(`${target} is a package directory (${target}/package.json)`);
  const index = certain(RESOLVE_EXTENSIONS.map((e) => `${target}/index${e}`));
  if (typeof index === 'string') return unresolved(index);
  const all = [...own, ...index];
  if (all.length === 1) return resolvedAs(all[0] as string);
  if (all.length === 0) return unresolved(`no file at ${target}`);
  return unresolved(`${target} is ambiguous (${all.join(', ')})`);
}

/**
 * A `#…` specifier through the `imports` of the nearest package.json: a string entry that is a
 * plain `./` path — one `*` for a pattern key and none for an exact key, no trailing `/` (Vite's
 * resolver appends the rest to a folder value), no `?` / `#` (a query the loader would strip;
 * Codex review r3) — kept inside the package directory.
 */
function resolveSubpathImport(from: string, spec: string, files: Files): Resolution {
  const pkg = nearestFile(dirOf(from), 'package.json', files);
  if (pkg === null) return unresolved('no package.json above the module');
  if ('why' in pkg) return unresolved(pkg.why);
  const file = pkg.dir === '' ? 'package.json' : `${pkg.dir}/package.json`;
  const json = parseJson(pkg.text);
  if (json === null) return unresolved(`${file} cannot be parsed`);
  const imports = json['imports'];
  if (typeof imports !== 'object' || imports === null || Array.isArray(imports)) {
    return unresolved(`${file} has no imports map`);
  }
  const hit = matchKey(Object.keys(imports), spec);
  if (hit === null) return unresolved(`${file} maps no imports entry to ${spec}`);
  if (hit === 'ambiguous') return unresolved(`${file} cannot decide the imports entry for ${spec}`);
  const value = (imports as Record<string, unknown>)[hit.key];
  if (typeof value !== 'string') return unresolved(`${file} imports ${hit.key} is conditional`);
  const stars = value.split('*').length - 1;
  if (
    !value.startsWith('./') ||
    value.endsWith('/') ||
    /[?#]/.test(value) ||
    stars !== (hit.key.includes('*') ? 1 : 0)
  ) {
    return unresolved(`${file} imports ${hit.key} is not a plain ./ path`);
  }
  const target = joinPath(pkg.dir, value.replace('*', hit.star));
  if (target === null || (pkg.dir !== '' && !target.startsWith(`${pkg.dir}/`))) {
    return unresolved(`${file} imports ${hit.key} leaves the package`);
  }
  return resolveModuleFile(target, files);
}

/**
 * The repository file an import specifier names, seen from the module at `from` (CT-06w): `./`
 * and `../` against the module's directory (resolveModuleFile); `#…` through the nearest
 * package.json `imports` (a string entry, one `*`; the query and fragment after the first `#`
 * dropped). A bare specifier is a package: Vitest resolves it through node_modules, not through
 * tsconfig `paths` (`resolve.tsconfigPaths` is off here), so it stays unresolved — as does a
 * conditional entry, a config that cannot be parsed, a directory, a symbolic link, an ambiguous
 * or missing file.
 */
export function resolveImport(from: string, spec: string, files: Files): Resolution {
  const clean = spec.startsWith('#')
    ? `#${spec.slice(1).replace(/[?#].*$/, '')}`
    : spec.replace(/[?#].*$/, '');
  if (clean === '.' || clean === '..' || clean.startsWith('./') || clean.startsWith('../')) {
    const target = resolveRelative(from, clean);
    return target === null
      ? unresolved('it leaves the repository')
      : resolveModuleFile(target, files);
  }
  if (clean.startsWith('#')) return resolveSubpathImport(from, clean, files);
  return unresolved('a package (a bare specifier; tsconfig paths are not used by Vitest here)');
}

/**
 * The modules a rule-test file loads, itself first, at the head: every string literal of a module
 * that resolves through a relative specifier (./, ../) to a code file `read` finds is followed
 * (imports, re-exports, dynamic imports, vi.mock paths, new URL(…) of a module), and so is every
 * import that resolves through `#…` (CT-06w), as long as `follow` accepts its path (the caller
 * keeps the walk to test code: implementation modules do not read test-support files). `read`
 * returns null for a file that does not exist; `kindOf` says what a path is (PathKind; without
 * it, a path `read` finds is a file and any other is absent).
 */
export function relativeClosure(
  file: string,
  read: Reader,
  follow: (path: string) => boolean,
  kindOf?: (path: string) => PathKind,
): Module[] {
  const cache = new Map<string, string | null>();
  const cached: Reader = (p) => {
    let text = cache.get(p);
    if (text === undefined) {
      text = read(p);
      cache.set(p, text);
    }
    return text;
  };
  const kinds = new Map<string, PathKind>();
  const files: Files = {
    read: cached,
    kind: (p) => {
      let k = kinds.get(p);
      if (k === undefined) {
        k = kindOf === undefined ? (cached(p) !== null ? 'file' : 'absent') : kindOf(p);
        kinds.set(p, k);
      }
      return k;
    },
  };
  const out: Module[] = [];
  const seen = new Set<string>();
  const queue = [file];
  const enqueue = (c: string): void => {
    if (CODE_FILE.test(c) && !seen.has(c) && follow(c) && cached(c) !== null) queue.push(c);
  };
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    const text = cached(path);
    if (text === null) continue;
    let tokens: Token[] | null;
    try {
      tokens = tokenize(text);
    } catch {
      tokens = null; // mayReadSupport: a module that cannot be read may read anything
    }
    const literals = tokens === null ? null : literalsOf(tokens);
    const listed =
      tokens === null ? { dirs: [], unresolved: null } : listedDirectories(tokens, path);
    const imports: ModuleImport[] =
      tokens === null
        ? []
        : importSpecifiers(tokens).map((s) => ({ ...s, ...resolveImport(path, s.spec, files) }));
    const dynamic = tokens === null ? null : (dynamicAccess(tokens) ?? listed.unresolved);
    out.push({
      path,
      text,
      literals,
      dynamic,
      lists: listed.dirs,
      imports,
      opaque:
        tokens === null
          ? 'it cannot be read as code'
          : (dynamic ??
            (listed.dirs.length > 0 ? `it lists ${listed.dirs.join(', ')}` : fileAccess(tokens))),
      closed: false,
    });
    for (const { text: s } of literals ?? []) {
      if (!s.startsWith('./') && !s.startsWith('../')) continue;
      const target = resolveRelative(path, s.replace(/[?#].*$/, ''));
      if (target === null) continue;
      for (const c of candidatesOf(target)) enqueue(c);
    }
    for (const i of imports) if (i.resolved !== null) enqueue(i.resolved);
  }
  // Closed modules (a fixpoint: a module importing a module that is not closed is not closed).
  const byPath = new Map(out.map((m) => [m.path, m]));
  const bare = (spec: string): boolean =>
    !spec.startsWith('#') && !/^\.\.?(\/|$)/.test(spec.replace(/[?#].*$/, ''));
  for (const m of out) {
    if (m.opaque !== null) continue;
    const open = m.imports.find((i) =>
      i.resolved === null ? !bare(i.spec) : !byPath.has(i.resolved) && follow(i.resolved),
    );
    if (open === undefined) m.closed = true;
    else if (open.resolved === null) m.opaque = `it imports ${open.spec}, which cannot be resolved`;
    else m.opaque = `it imports ${open.resolved}, which is not read here`;
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const m of out) {
      if (!m.closed) continue;
      const open = m.imports.find((i) => {
        const dep = i.resolved === null ? undefined : byPath.get(i.resolved);
        return dep !== undefined && !dep.closed;
      });
      if (open !== undefined) {
        m.closed = false;
        m.opaque = `it imports ${open.resolved}, which is not closed`;
        changed = true;
      }
    }
  }
  return out;
}

/**
 * Why a rule-test file may read a test-support file the task changed (a helper, fixture or data
 * file inside its test_paths), or null when it cannot (CT-06p; conservative: the file is then
 * judged as a whole). `closure` is the file and the modules it loads (relativeClosure). It may
 * when: the support file is one of those modules; one of them imports it (CT-06w: an import
 * specifier resolved to the support file's repository path); its file name occurs anywhere in
 * their text; its name without the extension occurs as a word in their string literals — except
 * inside an import specifier that resolves to another, closed module of the closure (CT-06w,
 * after B1-12g: `./kit.ts` of test/spec/platform/events is not
 * test/spec/identity/step-up-verify/kit.ts; a specifier that cannot be resolved, or resolved to a
 * file the closure does not follow or to a module that is not closed, still counts, the reason
 * says `unresolved import`); one of them lists a
 * directory that holds the support file (CT-06r: readdir & co. resolved statically; a listing
 * whose directory cannot be resolved counts as reading anything, the reason says so) or loads by
 * a computed name (glob, require, a dynamic import of a computed specifier) or cannot be
 * tokenized; or the support file is named after the rule-test file (a snapshot or screenshot:
 * CT-06r, after B1-12g, only below the rule-test file's own directory — `__snapshots__/x.test.ts.snap`,
 * `__screenshots__/x.test.ts/…` — a same-named file in another directory is another test).
 */
export function mayReadSupport(
  file: string,
  support: string,
  closure: readonly Module[],
): string | null {
  const name = baseName(support);
  const own = baseName(file);
  const dir = dirOf(file);
  const below =
    dir === '' ? support : support.startsWith(`${dir}/`) ? support.slice(dir.length + 1) : null;
  if (below !== null && (below.split('/').includes(own) || name.startsWith(`${own}.`))) {
    return `${support} is named after it (a snapshot or screenshot file)`;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const word = new RegExp(`(?<![\\w$.-])${escapeRegex(stem)}(?![\\w$-])`, 'u');
  const byPath = new Map(closure.map((m) => [m.path, m]));
  if (byPath.has(support)) return `it loads ${support}`;
  for (const m of closure) {
    const imported = m.imports.find((i) => i.resolved === support);
    if (imported !== undefined) return `${m.path} imports ${support} (${imported.spec})`;
    // CT-06w: the name rules skip an import specifier that resolves to another, closed module of
    // the closure (read here, every read of it and of what it imports seen by these rules); a
    // specifier that cannot be resolved, that resolves to a file the closure does not follow
    // (data, a style sheet, a module outside the test code) or to a module that is not closed
    // (it uses a file-system API, import.meta, a mock, a listing, an import not read here — it
    // may reach the support file in a way not seen; Codex reviews r3, r4) counts as before
    // (`unresolved import`).
    const within = (start: number, end: number): ModuleImport | undefined =>
      m.imports.find((i) => i.start <= start && end <= i.end);
    const uncertain = (i: ModuleImport): string | null => {
      if (i.resolved === null) return i.why;
      const dep = byPath.get(i.resolved);
      if (dep === undefined) return `${i.resolved} is not followed by the closure`;
      return dep.closed ? null : `${i.resolved} is not closed: ${dep.opaque}`;
    };
    const note = (what: string, i: ModuleImport, why: string): string =>
      `${m.path} names ${what} in an unresolved import ${i.spec} (${why})`;
    for (let at = m.text.indexOf(name); at >= 0; at = m.text.indexOf(name, at + 1)) {
      const i = within(at, at + name.length);
      if (i === undefined) return `${m.path} names ${name}`;
      const why = uncertain(i);
      if (why !== null) return note(name, i, why);
    }
    if (m.literals === null) return `${m.path} cannot be read as code, so it may read ${support}`;
    for (const l of m.literals) {
      if (!word.test(l.text)) continue;
      const i = within(l.start, l.end);
      if (i === undefined) return `${m.path} names ${stem}`;
      const why = uncertain(i);
      if (why !== null) return note(stem, i, why);
    }
    // The repository root is '' and holds every path (Codex review r2, S2).
    const listed = m.lists.find((d) => d === '' || support === d || support.startsWith(`${d}/`));
    if (listed !== undefined) return `${m.path} lists ${listed}, which holds ${support}`;
    if (m.dynamic !== null) return `${m.path} may read ${support}: ${m.dynamic}`;
  }
  return null;
}
