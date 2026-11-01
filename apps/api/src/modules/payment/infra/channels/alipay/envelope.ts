// B2-15k: the outer JSON of a synchronous Alipay answer. The signature covers the exact text of the
// `xxx_response` node (docs-mirror/alipay/guides/browser-02mse7.md:23-31), so the node is cut out of
// the answer byte for byte, never re-serialised. Ported from task/PAY-01; r3 建议改 ②: the scanner
// validates the complete JSON itself instead of promising it, and is not part of channels/index.ts.
// Also compiled by the `test` project: erasable syntax only.
import { isObject } from '../channel-common.ts';

export interface TopLevelMember {
  readonly key: string;
  /** Exact text of the value. */
  readonly raw: string;
}

/** Largest answer scanned; a bill's address or an order's fields are nowhere near it. */
const MAX_ANSWER_CHARS = 1_000_000;

function whitespaceEnd(text: string, from: number): number {
  let at = from;
  while (at < text.length && ' \t\r\n'.includes(text[at] ?? '')) at += 1;
  return at;
}

/** text[from] opens a string; the index just past its closing quote, or -1. */
function stringEnd(text: string, from: number): number {
  for (let at = from + 1; at < text.length; at += 1) {
    const char = text[at];
    if (char === '\\') at += 1;
    else if (char === '"') return at + 1;
  }
  return -1;
}

/** The index just past the value starting at text[from], or -1. The text is valid JSON here. */
function valueEnd(text: string, from: number): number {
  const first = text[from];
  if (first === '"') return stringEnd(text, from);
  if (first === '{' || first === '[') {
    let depth = 0;
    for (let at = from; at < text.length; at += 1) {
      const char = text[at];
      if (char === '"') {
        const end = stringEnd(text, at);
        if (end < 0) return -1;
        at = end - 1;
      } else if (char === '{' || char === '[') {
        depth += 1;
      } else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) return at + 1;
      }
    }
    return -1;
  }
  let at = from;
  while (at < text.length && !',} \t\r\n'.includes(text[at] ?? '')) at += 1;
  return at > from ? at : -1;
}

/**
 * The top-level members of a JSON object: their keys decoded (`"sign"` is `sign`), their values
 * as exact text, duplicates all returned, nested keys never. undefined for anything but one complete
 * valid JSON object.
 */
export function topLevelMembers(text: string): readonly TopLevelMember[] | undefined {
  if (text.length > MAX_ANSWER_CHARS) return undefined;
  try {
    if (!isObject(JSON.parse(text))) return undefined;
  } catch {
    return undefined;
  }
  const members: TopLevelMember[] = [];
  let at = whitespaceEnd(text, whitespaceEnd(text, 0) + 1);
  if (text[at] === '}') return members;
  for (;;) {
    const keyEnd = stringEnd(text, at);
    if (keyEnd < 0) return undefined;
    const key: unknown = JSON.parse(text.slice(at, keyEnd));
    if (typeof key !== 'string') return undefined;
    at = whitespaceEnd(text, whitespaceEnd(text, keyEnd) + 1);
    const end = valueEnd(text, at);
    if (end < 0) return undefined;
    members.push({ key, raw: text.slice(at, end) });
    at = whitespaceEnd(text, end);
    if (text[at] === '}') return members;
    at = whitespaceEnd(text, at + 1);
  }
}

/** The only text of a member, or undefined when it is absent or duplicated. */
export function onlyMember(members: readonly TopLevelMember[], key: string): string | undefined {
  const hits = members.filter((member) => member.key === key);
  return hits.length === 1 ? hits[0]?.raw : undefined;
}

/** The decoded value of a raw member when it is a JSON string. */
export function stringMember(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value: unknown = JSON.parse(raw);
  return typeof value === 'string' ? value : undefined;
}
