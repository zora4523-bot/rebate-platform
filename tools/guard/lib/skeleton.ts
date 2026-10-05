// Is a file inside the task paths a NotImplemented skeleton (规划/11 §2.3 step 3)? The rule-test
// author may add the shells the rule tests import, never an implementation. A keyword anywhere in
// the file proves nothing (a comment, or one real function next to a placeholder), so every
// function body that is new or changed against the base is checked on its own:
//
//   - its statements may only be `void <name>;`, `super(…);`, `this.<field> = <plain value>;`,
//     and it must end with `throw new NotImplemented(…)` / `throw new Error('NotImplemented…')`
//     (one string argument at most, no template expression);
//   - no nested function or arrow, no control flow, no call except `super(…)` and the throw;
//   - an arrow function with an expression body is never a skeleton.
//
// Bodies that are identical to a body of the base version are not looked at (adding a shell to a
// file that already has an implementation is allowed). Types, interfaces, imports, exports and
// top-level constants are not executable code and are not checked here.
//
// TypeScript is first turned into JavaScript with Node's own `module.stripTypeScriptTypes`
// (transform mode), so that type annotations cannot hide a body; only Node built-ins are used
// (tools/README.md). A file that cannot be transformed (TSX, decorators) is not a skeleton.
import { stripTypeScriptTypes } from 'node:module';

type Tok = { t: 'id' | 'punct' | 'str' | 'tmpl' | 'num' | 'regex'; v: string };

const SCRIPT = /\.(?:[cm]?ts|[cm]?js)$/;
const TS = /\.[cm]?ts$/;
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
const REGEX_AFTER_ID = new Set([
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
const PUNCT = [
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

/** TypeScript to JavaScript; null when Node cannot transform it. */
export function toJavaScript(path: string, text: string): string | null {
  if (!TS.test(path)) return text;
  const emit = process.emitWarning;
  // stripTypeScriptTypes is experimental in Node 24 and warns on every call.
  process.emitWarning = () => undefined;
  try {
    return stripTypeScriptTypes(text, { mode: 'transform' });
  } catch {
    return null;
  } finally {
    process.emitWarning = emit;
  }
}

/** A small JavaScript tokenizer: comments dropped, strings kept with their content. */
export function tokenize(js: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = js.length;
  const regexAllowed = (): boolean => {
    const prev = out[out.length - 1];
    if (prev === undefined) return true;
    if (prev.t === 'id') return REGEX_AFTER_ID.has(prev.v);
    if (prev.t === 'punct') return ![')', ']', '}'].includes(prev.v);
    return false;
  };
  while (i < n) {
    const c = js[i] ?? '';
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '/' && js[i + 1] === '/') {
      while (i < n && js[i] !== '\n') i += 1;
    } else if (c === '/' && js[i + 1] === '*') {
      const end = js.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let v = '';
      while (j < n && js[j] !== c) {
        if (js[j] === '\\') {
          v += js[j + 1] ?? '';
          j += 2;
        } else {
          v += js[j];
          j += 1;
        }
      }
      out.push({ t: 'str', v });
      i = j + 1;
    } else if (c === '`') {
      // A template literal; `${` inside marks it as carrying expressions.
      let j = i + 1;
      let depth = 0;
      let raw = '';
      while (j < n) {
        const d = js[j];
        if (d === '\\') {
          raw += `${d}${js[j + 1] ?? ''}`;
          j += 2;
          continue;
        }
        if (depth === 0 && d === '`') break;
        if (d === '$' && js[j + 1] === '{') {
          depth += 1;
          raw += '${';
          j += 2;
          continue;
        }
        if (depth > 0 && d === '}') depth -= 1;
        raw += d;
        j += 1;
      }
      out.push({ t: 'tmpl', v: raw });
      i = j + 1;
    } else if (/[A-Za-z_$\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$\u0080-￿]/.test(js[j] ?? '')) j += 1;
      out.push({ t: 'id', v: js.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(js[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(js[j] ?? '')) j += 1;
      out.push({ t: 'num', v: js.slice(i, j) });
      i = j;
    } else if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = js[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        else if (d === '\n') break;
        j += 1;
      }
      j += 1;
      while (j < n && /[a-z]/i.test(js[j] ?? '')) j += 1;
      out.push({ t: 'regex', v: js.slice(i, j) });
      i = j;
    } else {
      const p = PUNCT.find((x) => js.startsWith(x, i)) ?? c;
      out.push({ t: 'punct', v: p });
      i += p.length;
    }
  }
  return out;
}

type Body = {
  name: string;
  /** Token range of the body: [start, end) inside the braces, or the arrow's expression. */
  start: number;
  end: number;
  expression: boolean;
};

function isPunct(tok: Tok | undefined, v: string): boolean {
  return tok !== undefined && tok.t === 'punct' && tok.v === v;
}

function matching(toks: Tok[], open: number): number {
  const o = toks[open]?.v ?? '';
  const c = o === '{' ? '}' : o === '(' ? ')' : ']';
  let depth = 0;
  for (let k = open; k < toks.length; k += 1) {
    if (isPunct(toks[k], o)) depth += 1;
    else if (isPunct(toks[k], c)) {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return toks.length;
}

function matchingBack(toks: Tok[], close: number): number {
  let depth = 0;
  for (let k = close; k >= 0; k -= 1) {
    if (isPunct(toks[k], ')')) depth += 1;
    else if (isPunct(toks[k], '(')) {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** End of an arrow's expression body: the first `,` `;` `)` `]` `}` at depth 0. */
function expressionEnd(toks: Tok[], from: number): number {
  let depth = 0;
  for (let k = from; k < toks.length; k += 1) {
    const v = toks[k]?.t === 'punct' ? toks[k]?.v : '';
    if (v === '(' || v === '[' || v === '{') depth += 1;
    else if (v === ')' || v === ']' || v === '}') {
      if (depth === 0) return k;
      depth -= 1;
    } else if ((v === ',' || v === ';') && depth === 0) return k;
  }
  return toks.length;
}

/** The outermost function bodies of a token stream (nested ones are part of their parent). */
export function functionBodies(toks: Tok[]): Body[] {
  const bodies: Body[] = [];
  let k = 0;
  while (k < toks.length) {
    const tok = toks[k];
    if (isPunct(tok, '=>')) {
      const next = k + 1;
      if (isPunct(toks[next], '{')) {
        const end = matching(toks, next);
        bodies.push({ name: 'arrow function', start: next + 1, end, expression: false });
        k = end + 1;
      } else {
        const end = expressionEnd(toks, next);
        bodies.push({ name: 'arrow function', start: next, end, expression: true });
        k = end;
      }
      continue;
    }
    if (isPunct(tok, '{') && isPunct(toks[k - 1], ')')) {
      const open = matchingBack(toks, k - 1);
      const before = toks[open - 1];
      if (!(before?.t === 'id' && CONTROL.has(before.v))) {
        const end = matching(toks, k);
        const name = before?.t === 'id' && before.v !== 'function' ? before.v : 'function';
        bodies.push({ name, start: k + 1, end, expression: false });
        k = end + 1;
        continue;
      }
    }
    k += 1;
  }
  return bodies;
}

function key(toks: Tok[], body: Body): string {
  return toks
    .slice(body.start, body.end)
    .map((t) => `${t.t}:${t.v}`)
    .join(' ');
}

function hasCodeInside(statement: Tok[]): boolean {
  return statement.some(
    (t) =>
      (t.t === 'id' && (t.v === 'function' || t.v === 'class')) ||
      (t.t === 'punct' && t.v === '=>') ||
      (t.t === 'tmpl' && t.v.includes('${')),
  );
}

const NOT_IMPLEMENTED = /\bNotImplemented\b/;

function isNotImplementedThrow(st: Tok[]): boolean {
  // throw new <Ctor> ( [one string] )
  if (st.length < 5 || st[0]?.v !== 'throw' || st[1]?.v !== 'new' || st[2]?.t !== 'id') {
    return false;
  }
  const ctor = st[2].v;
  if (!isPunct(st[3], '(') || !isPunct(st[st.length - 1], ')')) return false;
  const args = st.slice(4, -1);
  if (args.length > 1) return false;
  const arg = args[0];
  if (arg !== undefined && arg.t !== 'str' && !(arg.t === 'tmpl' && !arg.v.includes('${'))) {
    return false;
  }
  if (NOT_IMPLEMENTED.test(ctor)) return true;
  return (
    (ctor === 'Error' || ctor === 'TypeError') && arg !== undefined && NOT_IMPLEMENTED.test(arg.v)
  );
}

/** Problems of one function body; [] when it is a NotImplemented shell. */
function bodyProblems(toks: Tok[], body: Body): string[] {
  if (body.expression) {
    return [`${body.name}: an arrow function with an expression body is an implementation`];
  }
  const statements: Tok[][] = [];
  let current: Tok[] = [];
  let depth = 0;
  for (const t of toks.slice(body.start, body.end)) {
    if (t.t === 'punct' && ['(', '[', '{'].includes(t.v)) depth += 1;
    if (t.t === 'punct' && [')', ']', '}'].includes(t.v)) depth -= 1;
    if (depth === 0 && isPunct(t, ';')) {
      if (current.length > 0) statements.push(current);
      current = [];
    } else {
      current.push(t);
    }
  }
  if (current.length > 0) statements.push(current);
  const last = statements[statements.length - 1];
  if (last === undefined || !isNotImplementedThrow(last)) {
    return [
      `${body.name}: does not end with throw new NotImplemented(…) / Error('NotImplemented…')`,
    ];
  }
  const problems: string[] = [];
  for (const st of statements.slice(0, -1)) {
    const head = st[0];
    const ok =
      !hasCodeInside(st) &&
      ((head?.v === 'void' && st.length === 2 && st[1]?.t === 'id') ||
        (head?.v === 'super' && isPunct(st[1], '(') && isPunct(st[st.length - 1], ')')) ||
        (head?.v === 'this' &&
          isPunct(st[1], '.') &&
          st[2]?.t === 'id' &&
          isPunct(st[3], '=') &&
          st.length > 4 &&
          st.slice(4).every((t) => t.t !== 'punct' || ['.', '[', ']'].includes(t.v))));
    if (!ok) {
      problems.push(
        `${body.name}: "${st.map((t) => t.v).join(' ')}" is not allowed in a skeleton ` +
          '(only void <name>, super(…), this.<field> = <value>, then the NotImplemented throw)',
      );
    }
  }
  return problems;
}

/**
 * Problems of a file that the rule-test author changed inside the task paths; [] when every new
 * or changed function body is a NotImplemented shell. `base` is the file before the change
 * (null for a new file).
 */
export function skeletonProblems(path: string, content: string, base: string | null): string[] {
  if (!SCRIPT.test(path)) {
    return ['not a TypeScript or JavaScript file: only NotImplemented skeleton modules go here'];
  }
  const js = toJavaScript(path, content);
  if (js === null) return ['cannot be read as erasable TypeScript (a skeleton must be)'];
  const toks = tokenize(js);
  const baseKeys = new Set<string>();
  if (base !== null) {
    const baseJs = toJavaScript(path, base);
    if (baseJs !== null) {
      const baseToks = tokenize(baseJs);
      for (const b of functionBodies(baseToks)) baseKeys.add(key(baseToks, b));
    }
  }
  const problems: string[] = [];
  for (const body of functionBodies(toks)) {
    if (baseKeys.has(key(toks, body))) continue;
    problems.push(...bodyProblems(toks, body));
  }
  return problems;
}
