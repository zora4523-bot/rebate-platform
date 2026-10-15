// Address-reference normalization shared by step ① (style values) and step ② (attributes).
// The only address an output may carry is a same-document fragment `#id`.

// Characters an id in a kept reference may not contain: whitespace / controls, quoting, CSS and
// markup delimiters, escapes. Anything else is not a plain fragment and is treated as external.
const LOCAL_REFERENCE = /^#([^\u0000- \u007f#'"()\\<>&{};,]+)$/;

// URL parsers strip leading and trailing C0 controls and spaces before parsing.
const URL_TRIM = /^[\u0000- ]+|[\u0000- ]+$/g;

/** `#id` (after URL trimming) → `id`; anything else → null. */
export function localId(reference: string): string | null {
  const match = LOCAL_REFERENCE.exec(reference.replace(URL_TRIM, ''));
  return match ? match[1]! : null;
}

const LOOSE_URL = /url\s*\(/gi;
const STRICT_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"'()\s]*))\s*\)/gi;

/**
 * Rewrites every `url(...)` in a value to the canonical `url(#id)`. Returns null when any url()
 * is not a plain local fragment or cannot be tokenized unambiguously.
 */
export function normalizeUrls(value: string): string | null {
  const loose = value.match(LOOSE_URL)?.length ?? 0;
  if (loose === 0) return value;
  let strict = 0;
  let external = false;
  const rewritten = value.replace(
    STRICT_URL,
    (_match, double: string | undefined, single: string | undefined, bare: string | undefined) => {
      strict++;
      const id = localId(double ?? single ?? bare ?? '');
      if (id === null) {
        external = true;
        return '';
      }
      return `url(#${id})`;
    },
  );
  if (external || strict !== loose) return null;
  return rewritten;
}

/** Removes the url(...) tokens recognized by normalizeUrls (for residue checks). */
export function withoutUrls(value: string): string {
  return value.replace(STRICT_URL, ' ');
}
