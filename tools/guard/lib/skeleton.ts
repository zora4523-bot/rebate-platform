// Is a file inside the task paths a NotImplemented skeleton (规划/11 §2.3 step 3)? The rule-test
// author may add the shells the rule tests import, never an implementation. A keyword anywhere in
// the file proves nothing, so every top-level statement that is new or changed against the base is
// checked (Codex reviews CR-05, CR2-01; fail-closed):
//
//   allowed  import …; export { … } [from …]; export * from …; (types and interfaces vanish
//            when the TypeScript is turned into JavaScript)
//            function declarations whose body is `throw new NotImplemented(…)` /
//            `throw new Error('NotImplemented…')`, optionally after `void <parameter>;` lines
//            classes whose members are such methods (constructor, get, set included) or fields
//            without an initializer
//   refused  everything else that runs: `const` / `let` / `var` (also `export const x = f()`,
//            `= Math.floor`, literal constants), expression statements, `export default <expr>`,
//            class fields with an initializer, static blocks, computed member names, parameter
//            defaults, arrow functions, nested functions, control flow, calls
//
// The base exemption is bound to the symbol: a declaration (function, class, variable, class
// member) is skipped only when the base has a declaration of the same name with exactly the same
// text. Anonymous statements are skipped only when the base has the identical statement.
//
// TypeScript is first turned into JavaScript with Node's own `module.stripTypeScriptTypes`
// (transform mode), so that type annotations cannot hide code; only Node built-ins are used
// (tools/README.md). A file that cannot be transformed (TSX, decorators) is not a skeleton.
import { stripTypeScriptTypes } from 'node:module';

type Tok = { t: 'id' | 'punct' | 'str' | 'tmpl' | 'num' | 'regex'; v: string };

const SCRIPT = /\.(?:[cm]?ts|[cm]?js)$/;
const TS = /\.[cm]?ts$/;
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

type Range = { start: number; end: number };

function isPunct(tok: Tok | undefined, v: string): boolean {
  return tok !== undefined && tok.t === 'punct' && tok.v === v;
}

function isId(tok: Tok | undefined, v?: string): boolean {
  return tok !== undefined && tok.t === 'id' && (v === undefined || tok.v === v);
}

/** Index of the bracket closing the one at `open` ({ ( [), or toks.length. */
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

/** Index of the first `;` at bracket depth 0 from `from`, or toks.length. */
function statementEnd(toks: Tok[], from: number): number {
  let depth = 0;
  for (let k = from; k < toks.length; k += 1) {
    const t = toks[k];
    if (t?.t !== 'punct') continue;
    if (t.v === '(' || t.v === '[' || t.v === '{') depth += 1;
    else if (t.v === ')' || t.v === ']' || t.v === '}') depth -= 1;
    else if (t.v === ';' && depth === 0) return k;
  }
  return toks.length;
}

function text(toks: Tok[], r: Range): string {
  return toks
    .slice(r.start, r.end)
    .map((t) => `${t.t}:${t.v}`)
    .join(' ');
}

type Member = { name: string | null; range: Range; problems: string[] };

type Statement = {
  kind: 'import' | 'reexport' | 'function' | 'class' | 'other';
  /** Declared name(s) the base exemption is bound to; [] for anonymous statements. */
  names: string[];
  range: Range;
  /** Problems when the statement is new or changed (members of a class are listed apart). */
  problems: string[];
  members: Member[];
};

const NOT_IMPLEMENTED = /\bNotImplemented\b/;

function isNotImplementedThrow(st: Tok[]): boolean {
  // throw new <Ctor> ( [one string] )
  if (st.length < 5 || !isId(st[0], 'throw') || !isId(st[1], 'new') || st[2]?.t !== 'id') {
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

/** Parameters: plain names and destructuring only (a default value runs code). */
function paramProblems(toks: Tok[], open: number, close: number, name: string): string[] {
  for (const t of toks.slice(open + 1, close)) {
    if (t.t === 'punct' && (t.v === '=' || t.v === '=>' || t.v === '(')) {
      return [`${name}: parameter defaults run code; a skeleton has none`];
    }
    if (t.t !== 'id' && t.t !== 'punct')
      return [`${name}: parameter defaults run code; a skeleton has none`];
  }
  return [];
}

/** The body of a skeleton: `void <name>;` lines, then the NotImplemented throw, nothing else. */
function bodyProblems(toks: Tok[], open: number, close: number, name: string): string[] {
  const statements: Tok[][] = [];
  let k = open + 1;
  while (k < close) {
    const end = Math.min(statementEnd(toks, k), close);
    const st = toks.slice(k, end);
    if (st.length > 0) statements.push(st);
    k = end + 1;
  }
  const last = statements[statements.length - 1];
  if (last === undefined || !isNotImplementedThrow(last)) {
    return [`${name}: does not end with throw new NotImplemented(…) / Error('NotImplemented…')`];
  }
  const problems: string[] = [];
  const isConstructor = name.endsWith('.constructor');
  statements.slice(0, -1).forEach((st, i) => {
    const voidLine = st.length === 2 && isId(st[0], 'void') && st[1]?.t === 'id';
    // TypeScript requires `super(…)` first in a derived constructor: plain arguments only.
    const superLine =
      isConstructor &&
      i === 0 &&
      isId(st[0], 'super') &&
      isPunct(st[1], '(') &&
      isPunct(st[st.length - 1], ')') &&
      st
        .slice(2, -1)
        .every(
          (t) =>
            t.t === 'id' || t.t === 'str' || t.t === 'num' || ['.', '[', ']', ','].includes(t.v),
        );
    if (!voidLine && !superLine) {
      problems.push(
        `${name}: "${st.map((t) => t.v).join(' ')}" is not allowed in a skeleton ` +
          '(only void <parameter>; and, first in a derived constructor, super(<plain values>))',
      );
    }
  });
  return problems;
}

/** A function or method from its `(`: parameters, then a block body. Returns the end index. */
function callable(toks: Tok[], paren: number, name: string): { end: number; problems: string[] } {
  if (!isPunct(toks[paren], '(')) return { end: paren, problems: [`${name}: not a function`] };
  const close = matching(toks, paren);
  if (!isPunct(toks[close + 1], '{')) {
    return { end: close + 1, problems: [`${name}: not a function with a block body`] };
  }
  const bodyEnd = matching(toks, close + 1);
  return {
    end: bodyEnd + 1,
    problems: [
      ...paramProblems(toks, paren, close, name),
      ...bodyProblems(toks, close + 1, bodyEnd, name),
    ],
  };
}

function classMembers(toks: Tok[], open: number, close: number, cls: string): Member[] {
  const members: Member[] = [];
  let k = open + 1;
  while (k < close) {
    if (isPunct(toks[k], ';')) {
      k += 1;
      continue;
    }
    const start = k;
    while (
      (isId(toks[k], 'static') ||
        isId(toks[k], 'async') ||
        ((isId(toks[k], 'get') || isId(toks[k], 'set')) &&
          !isPunct(toks[k + 1], '(') &&
          !isPunct(toks[k + 1], ';') &&
          !isPunct(toks[k + 1], '=')) ||
        isPunct(toks[k], '*')) &&
      k < close
    ) {
      k += 1;
    }
    const nameTok = toks[k];
    if (isPunct(nameTok, '{')) {
      const end = matching(toks, k);
      members.push({
        name: null,
        range: { start, end: end + 1 },
        problems: [`${cls}: a static block runs code`],
      });
      k = end + 1;
      continue;
    }
    if (
      nameTok === undefined ||
      isPunct(nameTok, '[') ||
      (nameTok.t !== 'id' && nameTok.t !== 'str' && nameTok.t !== 'num' && !isPunct(nameTok, '#'))
    ) {
      const end = Math.min(statementEnd(toks, k), close);
      members.push({
        name: null,
        range: { start, end: end + 1 },
        problems: [`${cls}: computed or unreadable member`],
      });
      k = end + 1;
      continue;
    }
    let nameIdx = k;
    if (isPunct(nameTok, '#')) nameIdx = k + 1;
    const name = `${cls}.${isPunct(nameTok, '#') ? '#' : ''}${toks[nameIdx]?.v ?? ''}`;
    if (isPunct(toks[nameIdx + 1], '(')) {
      const fn = callable(toks, nameIdx + 1, name);
      members.push({ name, range: { start, end: fn.end }, problems: fn.problems });
      k = fn.end;
      continue;
    }
    // A field: allowed only without an initializer.
    const end = Math.min(statementEnd(toks, nameIdx), close);
    const field = toks.slice(nameIdx + 1, end);
    members.push({
      name,
      range: { start, end: end + 1 },
      problems: field.length === 0 ? [] : [`${name}: a class field with an initializer runs code`],
    });
    k = end + 1;
  }
  return members;
}

/** The top-level statements of a module. */
export function topLevel(toks: Tok[]): Statement[] {
  const out: Statement[] = [];
  let k = 0;
  while (k < toks.length) {
    if (isPunct(toks[k], ';')) {
      k += 1;
      continue;
    }
    const start = k;
    if (isId(toks[k], 'import') && !isPunct(toks[k + 1], '(') && !isPunct(toks[k + 1], '.')) {
      const end = statementEnd(toks, k);
      out.push({
        kind: 'import',
        names: [],
        range: { start, end: end + 1 },
        problems: [],
        members: [],
      });
      k = end + 1;
      continue;
    }
    if (isId(toks[k], 'export') && (isPunct(toks[k + 1], '{') || isPunct(toks[k + 1], '*'))) {
      const end = statementEnd(toks, k);
      const st = toks.slice(k, end);
      // `export { a as b }` and re-exports run nothing; `export * as x` too.
      const ok = st.every(
        (t) => t.t === 'id' || t.t === 'str' || ['{', '}', ',', '*'].includes(t.v),
      );
      out.push({
        kind: 'reexport',
        names: [],
        range: { start, end: end + 1 },
        problems: ok ? [] : ['export: only plain export lists and re-exports'],
        members: [],
      });
      k = end + 1;
      continue;
    }
    let j = k;
    if (isId(toks[j], 'export')) j += 1;
    const isDefault = isId(toks[j], 'default');
    if (isDefault) j += 1;
    if (isId(toks[j], 'async')) j += 1;
    if (isId(toks[j], 'function')) {
      j += 1;
      if (isPunct(toks[j], '*')) j += 1;
      const name = isId(toks[j]) ? (toks[j]?.v ?? 'function') : 'default function';
      if (isId(toks[j])) j += 1;
      const fn = callable(toks, j, name);
      out.push({
        kind: 'function',
        names: [name],
        range: { start, end: fn.end },
        problems: fn.problems,
        members: [],
      });
      k = fn.end;
      continue;
    }
    if (isId(toks[j], 'class')) {
      j += 1;
      const name =
        isId(toks[j]) && !isId(toks[j], 'extends') ? (toks[j]?.v ?? 'class') : 'default class';
      if (isId(toks[j]) && !isId(toks[j], 'extends')) j += 1;
      const problems: string[] = [];
      if (isId(toks[j], 'extends')) {
        j += 1;
        // A plain (dotted) name only: anything else runs code.
        while (j < toks.length && !isPunct(toks[j], '{')) {
          if (!(toks[j]?.t === 'id' || isPunct(toks[j], '.'))) {
            problems.push(`${name}: extends must name a class, not compute one`);
          }
          j += 1;
        }
      }
      if (!isPunct(toks[j], '{')) {
        const end = statementEnd(toks, k);
        out.push({
          kind: 'other',
          names: [name],
          range: { start, end: end + 1 },
          problems: [`${name}: unreadable class`],
          members: [],
        });
        k = end + 1;
        continue;
      }
      const close = matching(toks, j);
      out.push({
        kind: 'class',
        names: [name],
        range: { start, end: close + 1 },
        problems,
        members: classMembers(toks, j, close, name),
      });
      k = close + 1;
      continue;
    }
    // Anything else runs code: variables, expressions, `export default <expr>`.
    const end = statementEnd(toks, k);
    let n = k;
    if (isId(toks[n], 'export')) n += 1;
    const names =
      isId(toks[n], 'const') || isId(toks[n], 'let') || isId(toks[n], 'var')
        ? [toks[n + 1]?.v ?? '']
        : [];
    const label =
      names[0] ??
      toks
        .slice(k, Math.min(end, k + 4))
        .map((t) => t.v)
        .join(' ');
    out.push({
      kind: 'other',
      names,
      range: { start, end: end + 1 },
      problems: [
        `${label}: executable top-level code is not a skeleton (only imports, exports, types, ` +
          'NotImplemented functions and classes of NotImplemented methods)',
      ],
      members: [],
    });
    k = end + 1;
  }
  return out;
}

type BaseIndex = { named: Map<string, Set<string>>; anonymous: Map<string, number> };

function indexBase(toks: Tok[]): BaseIndex {
  const named = new Map<string, Set<string>>();
  const anonymous = new Map<string, number>();
  const add = (name: string, body: string): void => {
    const set = named.get(name) ?? new Set<string>();
    set.add(body);
    named.set(name, set);
  };
  for (const st of topLevel(toks)) {
    const body = text(toks, st.range);
    if (st.names.length === 0) anonymous.set(body, (anonymous.get(body) ?? 0) + 1);
    for (const name of st.names) add(name, body);
    for (const m of st.members) if (m.name !== null) add(m.name, text(toks, m.range));
  }
  return { named, anonymous };
}

/**
 * Problems of a file that the rule-test author changed inside the task paths; [] when every new
 * or changed top-level statement is part of a NotImplemented skeleton. `base` is the file before
 * the change (null for a new file).
 */
export function skeletonProblems(path: string, content: string, base: string | null): string[] {
  if (!SCRIPT.test(path)) {
    return ['not a TypeScript or JavaScript file: only NotImplemented skeleton modules go here'];
  }
  const js = toJavaScript(path, content);
  if (js === null) return ['cannot be read as erasable TypeScript (a skeleton must be)'];
  const toks = tokenize(js);
  let index: BaseIndex = { named: new Map(), anonymous: new Map() };
  if (base !== null) {
    const baseJs = toJavaScript(path, base);
    if (baseJs !== null) index = indexBase(tokenize(baseJs));
  }
  const unchanged = (name: string | null, body: string): boolean => {
    if (name === null) return false;
    return index.named.get(name)?.has(body) === true;
  };
  const problems: string[] = [];
  for (const st of topLevel(toks)) {
    const body = text(toks, st.range);
    if (st.names.length === 0) {
      const left = index.anonymous.get(body) ?? 0;
      if (left > 0) {
        index.anonymous.set(body, left - 1);
        continue;
      }
      problems.push(...st.problems);
      continue;
    }
    if (st.names.every((n) => unchanged(n, body))) continue;
    problems.push(...st.problems);
    for (const m of st.members) {
      if (unchanged(m.name, text(toks, m.range))) continue;
      problems.push(...m.problems);
    }
  }
  return problems;
}
