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
// - A test block is unchanged only when the same block (same text under the same describe titles)
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
// judged by mayReadSupport: a file that may read one is judged as a whole (see there).
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

/** Normalised text of tokens[from..to]: single separators, a line break kept as a line break. */
function joinTokens(tokens: readonly Token[], from: number, to: number): string {
  let out = '';
  for (let i = from; i <= to; i += 1) {
    const t = tokens[i] as Token;
    out += i === from ? t.text : `${t.nl ? '\n' : ' '}${t.text}`;
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
    head: joinTokens(tokens, i, to - 1),
  };
}

export type TestBlock = {
  /** Matches the full names (describe > … > title) the block can produce. */
  pattern: RegExp;
  /** Readable title (wildcards shown as `*`), for notes. */
  title: string;
  /** Describe keys and normalised text: equal keys are the same test. */
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
  const suites: Call[] = [];
  const tests: Call[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    const kind = t.kind === 'id' ? names.get(t.text) : undefined;
    if (kind === undefined) continue;
    const call = callAt(tokens, match, i, kind);
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
  tokens.forEach((t, k) => {
    if (inBlock[k]) {
      pendingNl ||= t.nl;
      return;
    }
    shared += first ? t.text : `${pendingNl || t.nl ? '\n' : ' '}${t.text}`;
    first = false;
    pendingNl = false;
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
      key: `${around.map((s) => s.head).join('\u0001')}\u0000${joinTokens(tokens, c.start, c.end)}`,
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

/** String contents of a module: string literals and the static parts of templates, nested too. */
function literalTexts(tokens: readonly Token[]): string[] {
  const out: string[] = [];
  for (const t of flatten(tokens)) {
    if (t.kind === 'str' && typeof t.value === 'string') out.push(t.value);
    if (t.kind === 'tpl') for (const p of t.parts ?? []) if (p !== null) out.push(p);
  }
  return out;
}

/** Calls that list directories or load files / modules by a computed name. */
const DYNAMIC_ACCESS = new Set([
  'readdir',
  'readdirSync',
  'opendir',
  'opendirSync',
  'glob',
  'globSync',
  'require',
  'createRequire',
]);

/** The reason a module may load files it does not name, or null. */
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

export type Module = {
  path: string;
  text: string;
  /** String contents (literals, static template parts); null when the text cannot be tokenized. */
  literals: string[] | null;
  /** Why the module may load files it does not name (dynamicAccess), or null. */
  dynamic: string | null;
};

/**
 * The modules a rule-test file loads through relative specifiers (./, ../), itself first, at the
 * head: every string literal of a module that resolves to a code file `read` finds is followed
 * (imports, re-exports, dynamic imports, vi.mock paths, new URL(…) of a module), as long as
 * `follow` accepts its path (the caller keeps the walk to test code: implementation modules do
 * not read test-support files). `read` returns null for a file that does not exist.
 */
export function relativeClosure(
  file: string,
  read: (path: string) => string | null,
  follow: (path: string) => boolean,
): Module[] {
  const out: Module[] = [];
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    const text = read(path);
    if (text === null) continue;
    let tokens: Token[] | null;
    try {
      tokens = tokenize(text);
    } catch {
      tokens = null; // mayReadSupport: a module that cannot be read may read anything
    }
    const literals = tokens === null ? null : literalTexts(tokens);
    out.push({ path, text, literals, dynamic: tokens === null ? null : dynamicAccess(tokens) });
    for (const s of literals ?? []) {
      if (!s.startsWith('./') && !s.startsWith('../')) continue;
      const target = resolveRelative(path, s.replace(/[?#].*$/, ''));
      if (target === null) continue;
      const candidates = [
        target,
        target.replace(/\.js$/, '.ts'),
        `${target}.ts`,
        `${target}/index.ts`,
      ];
      for (const c of candidates) {
        if (CODE_FILE.test(c) && !seen.has(c) && follow(c) && read(c) !== null) queue.push(c);
      }
    }
  }
  return out;
}

/**
 * Why a rule-test file may read a test-support file the task changed (a helper, fixture or data
 * file inside its test_paths), or null when it cannot (CT-06p; conservative: the file is then
 * judged as a whole). `closure` is the file and the modules it loads (relativeClosure). It may
 * when: the support file is one of those modules; its file name occurs anywhere in their text;
 * its name without the extension occurs as a word in their string literals; one of them lists
 * directories or loads by a computed name (readdir, glob, require, a dynamic import of a computed
 * specifier) or cannot be tokenized; or the support file is named after the rule-test file (a
 * snapshot or screenshot: a path segment equal to its file name, or a file name that starts with
 * it).
 */
export function mayReadSupport(
  file: string,
  support: string,
  closure: readonly Module[],
): string | null {
  const name = baseName(support);
  const own = baseName(file);
  if (support.split('/').includes(own) || name.startsWith(`${own}.`)) {
    return `${support} is named after it (a snapshot or screenshot file)`;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const word = new RegExp(`(?<![\\w$.-])${escapeRegex(stem)}(?![\\w$-])`, 'u');
  for (const m of closure) {
    if (m.path === support) return `it loads ${support}`;
    if (m.text.includes(name)) return `${m.path} names ${name}`;
    if (m.literals === null) return `${m.path} cannot be read as code, so it may read ${support}`;
    if (m.literals.some((s) => word.test(s))) return `${m.path} names ${stem}`;
    if (m.dynamic !== null) return `${m.path} may read ${support}: ${m.dynamic}`;
  }
  return null;
}
