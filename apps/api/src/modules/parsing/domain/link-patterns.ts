// B1-07a: host/path classification against the single platform link pattern table (规划/08
// BR-ATTR-29 细则「平台链接形态表」; specs/link-patterns.yaml header). Pure code: the table is
// passed in (platform.getLinkPatterns() in production, a synthetic table in rule tests); no domain
// is hard-coded here.
import type { LinkPatternsSpec } from '../../platform/index.ts';

export type LinkPatternCategory = LinkPatternsSpec['rules'][number]['category'];

export interface ParsingUrlMatch {
  readonly platform: string;
  readonly category: LinkPatternCategory;
}

/** Specific shapes win over the whole-domain union_host rule, independent of rule order. */
const PRIORITY: readonly LinkPatternCategory[] = ['product', 'promo', 'union_host'];

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

/** Decodes each valid %XX exactly once, reading the bytes as UTF-8 (invalid → U+FFFD). */
function decodeOnce(path: string): string {
  const raw = utf8Encoder.encode(path);
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

/** Host and decoded path of a well-formed https URL without user info; anything else is null. */
function normalise(raw: string): { readonly host: string; readonly path: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return null;
  return { host, path: decodeOnce(url.pathname) };
}

const patternCache = new Map<string, RegExp>();

/** `**` any characters (including / and newlines), `*` anything but /, the rest literal. */
function patternRegExp(pattern: string): RegExp {
  const cached = patternCache.get(pattern);
  if (cached !== undefined) return cached;
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.startsWith('**', i)) {
      source += '[\\s\\S]*';
      i++;
    } else if (pattern[i] === '*') {
      source += '[^/]*';
    } else {
      source += (pattern[i] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  const compiled = new RegExp(`^${source}$`);
  patternCache.set(pattern, compiled);
  return compiled;
}

function hostMatches(host: string, entry: string): boolean {
  return host === entry || host.endsWith(`.${entry}`);
}

/**
 * Classifies a URL by host and path only (query and fragment never take part). union_host rules
 * match the whole registered domain; product and promo rules also need a path pattern match.
 * Returns null for an unparsable, non-https or user-info URL and for one that hits no rule.
 */
export function classifyParsingUrl(
  url: string,
  patterns: LinkPatternsSpec,
): ParsingUrlMatch | null {
  const parts = normalise(url);
  if (parts === null) return null;
  for (const category of PRIORITY) {
    for (const rule of patterns.rules) {
      if (rule.category !== category) continue;
      if (!rule.hosts.some((entry) => hostMatches(parts.host, entry))) continue;
      if (
        category === 'union_host' ||
        rule.path_patterns.some((pattern) => patternRegExp(pattern).test(parts.path))
      ) {
        return { platform: rule.platform, category };
      }
    }
  }
  return null;
}
