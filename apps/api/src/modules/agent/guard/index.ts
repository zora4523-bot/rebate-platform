// B3-06a · BR-AI-03/05/06/18 · SPEC_REF e9fe98ab6e8890ca40923ccd5b6ae5b56dac5aba.
// Pure OutputGuard pieces, not wired yet (B3-05 calls them before ctx.text).
export { AMOUNT_PLACEHOLDER, filterSegment } from './filter.ts';
export type { FilterHit } from './filter.ts';
export { createSentenceBuffer } from './buffer.ts';
export type { SentenceBuffer } from './buffer.ts';
export { MAX_SENTENCES, createOutputGuard } from './output-guard.ts';
export type {
  GuardEmit,
  GuardSummary,
  OutputGuard,
  ReviewVerdict,
  SentenceReviewPort,
} from './output-guard.ts';

// ---------------------------------------------------------------------------------------------
// BR-AI-05: <untrusted> delimiting. Inside the wrapper neither the text nor its NFKC form holds
// `<` or `>`; `&` and every code point whose NFKC holds `<` or `>` become character references,
// so the round trip is lossless for any string (lone surrogates included).

const OPEN_TAG = '<untrusted>';
const CLOSE_TAG = '</untrusted>';

/** Replacement for one UTF-16 unit, or null. Every escaped character is a BMP unit. */
function escapeUnit(unit: number): string | null {
  switch (unit) {
    case 0x26:
      return '&amp;';
    case 0x3c:
    case 0x3e:
    case 0xfe64:
    case 0xfe65:
    case 0xff1c:
    case 0xff1e:
      return `&#x${unit.toString(16).toUpperCase()};`;
    default:
      return null;
  }
}

// One pass over the code units; untouched runs are copied by slice.
export function wrapUntrusted(text: string): string {
  let out = OPEN_TAG;
  let last = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit !== 0x26 && unit !== 0x3c && unit !== 0x3e && unit < 0xfe64) continue;
    const replacement = escapeUnit(unit);
    if (replacement === null) continue;
    out += text.slice(last, i) + replacement;
    last = i + 1;
  }
  return out + text.slice(last) + CLOSE_TAG;
}

export function unwrapUntrusted(wrapped: string): string {
  if (!wrapped.startsWith(OPEN_TAG) || !wrapped.endsWith(CLOSE_TAG)) {
    throw new Error('unwrapUntrusted: not an <untrusted> block');
  }
  const end = wrapped.length - CLOSE_TAG.length;
  let out = '';
  let last = OPEN_TAG.length;
  let amp = wrapped.indexOf('&', last);
  while (amp !== -1 && amp < end) {
    out += wrapped.slice(last, amp);
    const semi = wrapped.indexOf(';', amp);
    const body = semi === -1 || semi >= end ? '' : wrapped.slice(amp + 1, semi);
    if (body === 'amp') {
      out += '&';
      last = semi + 1;
    } else if (/^#x[0-9A-F]{1,6}$/u.test(body) && Number.parseInt(body.slice(2), 16) <= 0x10ffff) {
      out += String.fromCodePoint(Number.parseInt(body.slice(2), 16));
      last = semi + 1;
    } else {
      out += '&';
      last = amp + 1;
    }
    amp = wrapped.indexOf('&', last);
  }
  return out + wrapped.slice(last, end);
}

// ---------------------------------------------------------------------------------------------
// BR-AI-03: identity arguments. The list mirrors specs/agent-identity-fields.txt (a rule test
// compares them); keys compare lower-cased without `_` and `-`.

export const IDENTITY_FIELDS: readonly string[] = Object.freeze([
  'user_id',
  'uid',
  'app_id',
  'device_id',
  'scene',
  'pid',
  'p_id',
  'adzone_id',
  'site_id',
  'position_id',
  'relation_id',
  'special_id',
  'sub_union_id',
  'custom_parameters',
  'union_id',
]);

export function normalizeIdentityKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/gu, '');
}

const IDENTITY_KEYS: ReadonlySet<string> = new Set(IDENTITY_FIELDS.map(normalizeIdentityKey));

/** Identity keys at any depth of objects and arrays, as written by the model. */
export function findIdentityFields(args: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (IDENTITY_KEYS.has(normalizeIdentityKey(key))) found.push(key);
      visit(child);
    }
  };
  visit(args);
  return found;
}

export type ToolCallDecision =
  | { readonly kind: 'execute' }
  | {
      readonly kind: 'reject';
      readonly result: { readonly error: 'invalid_args' };
      readonly status: 'rejected';
      readonly alert: boolean;
      readonly identityFields: readonly string[];
    };

/** Never drops a field and goes on (O-G9): any identity key or schema failure rejects. */
export function decideToolCall(input: {
  readonly schemaValid: boolean;
  readonly args: unknown;
}): ToolCallDecision {
  const identityFields = findIdentityFields(input.args);
  if (identityFields.length === 0 && input.schemaValid) return { kind: 'execute' };
  return {
    kind: 'reject',
    result: { error: 'invalid_args' },
    status: 'rejected',
    alert: identityFields.length > 0,
    identityFields,
  };
}
