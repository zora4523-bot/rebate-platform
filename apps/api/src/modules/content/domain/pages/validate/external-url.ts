// F1-09c: ExternalPage url checks (BR-ATTR-29 ①, BR-ID-33 细则). Normalisation and host matching
// follow specs/link-patterns.yaml's header; written here rather than imported from parsing so the
// content domain stays free of that module's Nest wiring.
import type { LinkPatternsSpec } from '../../../../platform/index.ts';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

/** Decodes each valid %XX exactly once, reading the bytes as UTF-8 (invalid → U+FFFD). */
export function decodeOnce(text: string): string {
  const raw = utf8Encoder.encode(text);
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const byte = raw[i] ?? 0;
    if (byte === 0x25 && i + 2 < raw.length) {
      const high = hexValue(raw[i + 1] ?? 0);
      const low = hexValue(raw[i + 2] ?? 0);
      if (high >= 0 && low >= 0) {
        bytes.push(high * 16 + low);
        i += 2;
        continue;
      }
    }
    bytes.push(byte);
  }
  return utf8Decoder.decode(new Uint8Array(bytes));
}

/** Lower-cased host without trailing dot of a well-formed https URL without user info; else null. */
export function normalisedHttpsHost(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return host === '' ? null : host;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TWO_HEX = /^[0-9A-Fa-f]{2}$/;

/** `%NAME%` at any `%` position (overlaps included), except a two-hex-digit percent escape. */
function hasPercentPlaceholder(text: string): boolean {
  for (let start = text.indexOf('%'); start !== -1; start = text.indexOf('%', start + 1)) {
    const end = text.indexOf('%', start + 1);
    if (end === -1) return false;
    const name = text.slice(start + 1, end);
    if (IDENTIFIER.test(name) && !TWO_HEX.test(name)) return true;
  }
  return false;
}

function hasPlaceholderIn(text: string): boolean {
  return text.includes('{') || text.includes('}') || hasPercentPlaceholder(text);
}

/** Personal-data placeholder syntax in the raw url or after one percent-decoding pass. */
export function hasPersonalPlaceholder(raw: string): boolean {
  return hasPlaceholderIn(raw) || hasPlaceholderIn(decodeOnce(raw));
}

function hostMatches(host: string, entry: string): boolean {
  return host === entry || host.endsWith(`.${entry}`);
}

/** Whether the normalised host falls in any union_host rule's registered domains. */
export function isUnionHost(host: string, linkPatterns: LinkPatternsSpec): boolean {
  return linkPatterns.rules.some(
    (rule) =>
      rule.category === 'union_host' &&
      rule.hosts.some((entry) => hostMatches(host, entry.toLowerCase().replace(/\.$/, ''))),
  );
}
