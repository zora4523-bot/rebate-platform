// Strict YAML subset parser used by gates (task ledger, approvals, risk map).
// No dependency on a YAML library on purpose (ADR-0001 lists none): the accepted subset is small
// enough to parse here, and everything outside it is rejected instead of being guessed.
//
// Supported: block mappings, block sequences (of scalars or mappings), flow sequences of scalars
// `[a, b]`, empty flow collections `[]` / `{}`, plain / single-quoted / double-quoted scalars,
// integers, `true|false`, `null|~`, `#` comments, literal block scalars `|` and `|-`,
// 2-space indentation. Anything else throws a YamlLiteError carrying the 1-based line number.

export class YamlLiteError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`yaml-lite: line ${line}: ${message}`);
    this.name = 'YamlLiteError';
    this.line = line;
  }
}

type Sig = { index: number; no: number; indent: number; body: string };

const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0',
  '"': '"',
  '\\': '\\',
  '/': '/',
  ' ': ' ',
};

const RESERVED_START: Record<string, string> = {
  '&': 'anchors are not supported',
  '*': 'aliases are not supported',
  '!': 'tags are not supported',
  '|': 'unsupported block scalar header (only "|" and "|-" are supported)',
  '>': 'folded block scalars are not supported',
  '%': 'directives and "%" scalars are not supported',
  '@': 'reserved indicator "@"',
  '`': 'reserved indicator "`"',
};

function isSeqEntry(body: string): boolean {
  return body === '-' || body.startsWith('- ');
}

function resolvePlain(s: string, no: number): unknown {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^(True|TRUE|False|FALSE|Null|NULL)$/.test(s)) {
    throw new YamlLiteError(`ambiguous scalar "${s}": use lower case or quote it`, no);
  }
  if (/^-?(0|[1-9][0-9]*)$/.test(s)) {
    const n = Number(s);
    if (!Number.isSafeInteger(n)) {
      throw new YamlLiteError(`integer "${s}" is outside the safe range: quote it`, no);
    }
    return n;
  }
  if (
    /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s) ||
    /^[-+]?0[xo][0-9a-fA-F]+$/.test(s) ||
    /^[-+]?\.(inf|Inf|INF)$/.test(s) ||
    /^\.(nan|NaN|NAN)$/.test(s)
  ) {
    throw new YamlLiteError(`only plain integers are supported as numbers: quote "${s}"`, no);
  }
  return s;
}

function readQuoted(text: string, start: number, no: number): { value: string; end: number } {
  const quote = text[start];
  let out = '';
  let i = start + 1;
  if (quote === "'") {
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "'") {
        if (text[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return { value: out, end: i + 1 };
      }
      out += c;
    }
    throw new YamlLiteError(
      'unterminated single-quoted scalar (multi-line scalars are not supported)',
      no,
    );
  }
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return { value: out, end: i + 1 };
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = text[i + 1];
    if (e === undefined) break;
    if (e === 'u' || e === 'x') {
      const len = e === 'u' ? 4 : 2;
      const hex = text.slice(i + 2, i + 2 + len);
      if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) {
        throw new YamlLiteError(`invalid \\${e} escape in double-quoted scalar`, no);
      }
      out += String.fromCharCode(parseInt(hex, 16));
      i += 1 + len;
      continue;
    }
    const mapped = DOUBLE_QUOTE_ESCAPES[e];
    if (mapped === undefined) {
      throw new YamlLiteError(`unsupported escape "\\${e}" in double-quoted scalar`, no);
    }
    out += mapped;
    i++;
  }
  throw new YamlLiteError(
    'unterminated double-quoted scalar (multi-line scalars are not supported)',
    no,
  );
}

function ensureOnlyComment(rest: string, no: number): void {
  if (/^\s*$/.test(rest) || /^\s+#/.test(rest)) return;
  throw new YamlLiteError(`unexpected text after value: "${rest.trim()}"`, no);
}

function rejectReservedStart(text: string, no: number): void {
  const first = text[0];
  if (first === undefined) return;
  const reason = RESERVED_START[first];
  if (reason !== undefined) throw new YamlLiteError(reason, no);
  if (text === '?' || text.startsWith('? ')) {
    throw new YamlLiteError('complex mapping keys ("? ") are not supported', no);
  }
}

function stripTrailingComment(text: string): string {
  const m = /\s#/.exec(text);
  return (m ? text.slice(0, m.index) : text).trimEnd();
}

function readFlowSequence(text: string, no: number): unknown[] {
  const out: unknown[] = [];
  let i = 1;
  const skipSpaces = (): void => {
    while (text[i] === ' ') i++;
  };
  skipSpaces();
  if (text[i] === ']') {
    ensureOnlyComment(text.slice(i + 1), no);
    return out;
  }
  for (;;) {
    skipSpaces();
    const c = text[i];
    if (c === undefined) {
      throw new YamlLiteError(
        'unterminated flow sequence (multi-line flow sequences are not supported)',
        no,
      );
    }
    if (c === '"' || c === "'") {
      const q = readQuoted(text, i, no);
      out.push(q.value);
      i = q.end;
    } else if (c === '[' || c === '{') {
      throw new YamlLiteError('nested flow collections are not supported', no);
    } else if (c === ',' || c === ']') {
      throw new YamlLiteError('empty entry in flow sequence', no);
    } else {
      let j = i;
      while (j < text.length && text[j] !== ',' && text[j] !== ']') {
        const d = text[j];
        if (d === '[' || d === '{' || d === '}') {
          throw new YamlLiteError('nested flow collections are not supported', no);
        }
        j++;
      }
      if (j >= text.length) {
        throw new YamlLiteError(
          'unterminated flow sequence (multi-line flow sequences are not supported)',
          no,
        );
      }
      const raw = text.slice(i, j).trim();
      if (raw.startsWith('#') || /\s#/.test(raw)) {
        throw new YamlLiteError('comments inside a flow sequence are not supported', no);
      }
      if (/:( |$)/.test(raw)) {
        throw new YamlLiteError('flow mappings are not supported', no);
      }
      rejectReservedStart(raw, no);
      out.push(resolvePlain(raw, no));
      i = j;
    }
    skipSpaces();
    if (text[i] === ',') {
      i++;
      skipSpaces();
      if (text[i] === ']') throw new YamlLiteError('trailing comma in flow sequence', no);
      continue;
    }
    if (text[i] === ']') {
      i++;
      break;
    }
    throw new YamlLiteError('expected "," or "]" in flow sequence', no);
  }
  ensureOnlyComment(text.slice(i), no);
  return out;
}

function parseInline(text: string, no: number): unknown {
  const t = text.trim();
  if (t === '' || t.startsWith('#')) return null;
  const c = t[0];
  if (c === '"' || c === "'") {
    const q = readQuoted(t, 0, no);
    ensureOnlyComment(t.slice(q.end), no);
    return q.value;
  }
  if (c === '[') return readFlowSequence(t, no);
  if (c === '{') {
    if (/^\{ *\}(\s+#.*)?$/.test(t)) return {};
    throw new YamlLiteError('flow mappings are not supported (only the empty "{}")', no);
  }
  rejectReservedStart(t, no);
  if (isSeqEntry(t)) {
    throw new YamlLiteError('a sequence entry is not allowed here', no);
  }
  const plain = stripTrailingComment(t);
  if (/:( |$)/.test(plain)) {
    throw new YamlLiteError('plain scalar contains ": " (quote the value)', no);
  }
  return resolvePlain(plain, no);
}

/** Splits `key: rest`; returns null when the text is not a mapping entry. */
function splitKey(body: string, no: number): { key: string; rest: string } | null {
  const c = body[0];
  if (c === '"' || c === "'") {
    const q = readQuoted(body, 0, no);
    const after = body[q.end];
    const next = body[q.end + 1];
    if (after === ':' && (next === undefined || next === ' ')) {
      return { key: q.value, rest: body.slice(q.end + 1) };
    }
    return null;
  }
  const comment = /\s#/.exec(body);
  const limit = comment ? comment.index : body.length;
  for (let i = 0; i < limit; i++) {
    if (body[i] !== ':') continue;
    const next = body[i + 1];
    if (next !== undefined && next !== ' ') continue;
    const key = body.slice(0, i).trimEnd();
    if (key === '') throw new YamlLiteError('empty mapping key', no);
    rejectReservedStart(key, no);
    if (key.startsWith('[') || key.startsWith('{')) {
      throw new YamlLiteError('flow collections cannot be used as mapping keys', no);
    }
    return { key, rest: body.slice(i + 1) };
  }
  return null;
}

export function parseYamlLite(text: string): unknown {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = src.split(/\r?\n/);
  // A sequence entry `- key: value` is re-read as a mapping line indented by two more spaces.
  const overrides = new Map<number, { indent: number; body: string }>();
  let pos = 0;

  const leadingSpaces = (raw: string, no: number): number => {
    let indent = 0;
    while (indent < raw.length && raw[indent] === ' ') indent++;
    if (raw[indent] === '\t') {
      throw new YamlLiteError('tab character in indentation (use 2 spaces)', no);
    }
    return indent;
  };

  /** Moves to the next line that is neither blank nor a comment and returns it unconsumed. */
  const peek = (): Sig | null => {
    while (pos < lines.length) {
      const raw = lines[pos] ?? '';
      const no = pos + 1;
      const override = overrides.get(pos);
      if (override) return { index: pos, no, indent: override.indent, body: override.body };
      if (raw.trim() === '') {
        pos++;
        continue;
      }
      const indent = leadingSpaces(raw, no);
      const body = raw.slice(indent).trimEnd();
      if (body.startsWith('#')) {
        pos++;
        continue;
      }
      if (body.includes('\t')) {
        throw new YamlLiteError(
          'tab character (use spaces, or "\\t" inside a double-quoted scalar)',
          no,
        );
      }
      if (indent === 0 && (body === '---' || body.startsWith('--- ') || body === '...')) {
        throw new YamlLiteError('multiple documents are not supported', no);
      }
      return { index: pos, no, indent, body };
    }
    return null;
  };

  const parseBlockScalar = (parentIndent: number, strip: boolean): string => {
    const need = parentIndent + 2;
    const content: string[] = [];
    let started = false;
    while (pos < lines.length) {
      const raw = lines[pos] ?? '';
      const no = pos + 1;
      if (raw.trim() === '') {
        content.push('');
        pos++;
        continue;
      }
      const indent = leadingSpaces(raw, no);
      if (indent < need) {
        if (indent > parentIndent) {
          throw new YamlLiteError('block scalar content must be indented by exactly 2 spaces', no);
        }
        break;
      }
      if (!started && indent !== need) {
        throw new YamlLiteError('block scalar content must be indented by exactly 2 spaces', no);
      }
      started = true;
      content.push(raw.slice(need));
      pos++;
    }
    while (content.length > 0 && content[content.length - 1] === '') content.pop();
    if (content.length === 0) return '';
    return content.join('\n') + (strip ? '' : '\n');
  };

  const blockHeader = (rest: string, no: number): { strip: boolean } | null => {
    const t = rest.trim();
    if (!t.startsWith('|') && !t.startsWith('>')) return null;
    const m = /^\|(-)?(\s+#.*)?$/.exec(t);
    if (!m) {
      throw new YamlLiteError(
        t.startsWith('>')
          ? 'folded block scalars are not supported'
          : 'unsupported block scalar header (only "|" and "|-" are supported)',
        no,
      );
    }
    return { strip: m[1] === '-' };
  };

  const parseMapping = (indent: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (;;) {
      const l = peek();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) {
        throw new YamlLiteError(`unexpected indentation (expected ${indent} spaces)`, l.no);
      }
      if (isSeqEntry(l.body)) {
        throw new YamlLiteError(
          'sequence entry where a mapping key was expected (a sequence under a key must be indented by 2 spaces)',
          l.no,
        );
      }
      const kv = splitKey(l.body, l.no);
      if (!kv) throw new YamlLiteError('expected "key: value"', l.no);
      if (kv.key === '<<') throw new YamlLiteError('merge keys are not supported', l.no);
      if (kv.key === '__proto__') throw new YamlLiteError('key "__proto__" is not allowed', l.no);
      if (Object.hasOwn(out, kv.key)) {
        throw new YamlLiteError(`duplicate key "${kv.key}"`, l.no);
      }
      overrides.delete(l.index);
      pos = l.index + 1;
      const rest = kv.rest.trim();
      if (rest === '' || rest.startsWith('#')) {
        const n = peek();
        if (n && n.indent > indent) {
          if (n.indent !== indent + 2) {
            throw new YamlLiteError('nested blocks must be indented by exactly 2 spaces', n.no);
          }
          out[kv.key] = parseNode(indent + 2);
        } else {
          out[kv.key] = null;
        }
        continue;
      }
      const header = blockHeader(rest, l.no);
      out[kv.key] = header ? parseBlockScalar(indent, header.strip) : parseInline(rest, l.no);
    }
    return out;
  };

  const parseSequence = (indent: number): unknown[] => {
    const out: unknown[] = [];
    for (;;) {
      const l = peek();
      if (!l || l.indent < indent) break;
      if (l.indent > indent) {
        throw new YamlLiteError(`unexpected indentation (expected ${indent} spaces)`, l.no);
      }
      if (!isSeqEntry(l.body)) {
        throw new YamlLiteError('expected a "- " sequence entry', l.no);
      }
      const rest = l.body.slice(2);
      if (rest.startsWith(' ')) {
        throw new YamlLiteError('exactly one space is required after "-"', l.no);
      }
      if (rest === '' || rest.startsWith('#')) {
        pos = l.index + 1;
        const n = peek();
        if (n && n.indent > indent) {
          throw new YamlLiteError('a sequence entry must start on the "- " line', n.no);
        }
        out.push(null);
        continue;
      }
      if (isSeqEntry(rest) || rest.startsWith('[')) {
        throw new YamlLiteError('sequences of sequences are not supported', l.no);
      }
      const header = blockHeader(rest, l.no);
      if (header) {
        pos = l.index + 1;
        out.push(parseBlockScalar(indent, header.strip));
        continue;
      }
      if (!rest.startsWith('{') && splitKey(rest, l.no)) {
        overrides.set(l.index, { indent: indent + 2, body: rest });
        out.push(parseMapping(indent + 2));
        continue;
      }
      pos = l.index + 1;
      out.push(parseInline(rest, l.no));
    }
    return out;
  };

  const parseNode = (indent: number): unknown => {
    const l = peek();
    if (!l) return null;
    return isSeqEntry(l.body) ? parseSequence(indent) : parseMapping(indent);
  };

  // An optional single leading document marker is accepted; any later one is rejected by peek().
  while (pos < lines.length) {
    const raw = lines[pos] ?? '';
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) {
      pos++;
      continue;
    }
    if (raw.trimEnd() === '---') pos++;
    break;
  }
  const first = peek();
  if (!first) return null;
  if (first.indent !== 0) {
    throw new YamlLiteError('top-level content must not be indented', first.no);
  }
  const value = parseNode(0);
  const rest = peek();
  if (rest) throw new YamlLiteError('unexpected content after the document', rest.no);
  return value;
}
