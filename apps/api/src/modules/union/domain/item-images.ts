// B1-22s: image fields of the union item detail (BR-ATTR-10 细则「分享页与分享赚入口页」素材图;
// 规划/09 CAP-TB-02、CAP-JD-02、CAP-PDD-02). Pure cleaning every adapter's images go through:
// only `https://` absolute addresses without whitespace or control characters, at most 2048
// characters; image_urls deduplicated (first occurrence kept), in upstream order, at most 9.
// Invalid entries are dropped without an error; a field with nothing left is absent.
// image_urls is the upstream multi-image list as given: the main image is neither added to it
// nor removed from it, and main_image_url is never filled from image_urls.

/** What an adapter read from its upstream, before cleaning; any value may be malformed. */
export interface RawItemImages {
  readonly main_image_url?: unknown;
  readonly image_urls?: unknown;
}

/** The cleaned image fields of UnionItemDetail; a field without a valid value is absent. */
export interface ItemImages {
  readonly main_image_url?: string;
  readonly image_urls?: readonly string[];
}

/** At most this many entries in image_urls (BR-ATTR-10 素材图 ≤ 9). */
export const MAX_ITEM_IMAGES = 9;
/** Longest accepted image address, in UTF-16 code units. */
export const MAX_ITEM_IMAGE_URL_LENGTH = 2048;

const HTTPS = 'https://';

/** Whitespace (incl. U+3000 and other Unicode spaces) or a C0 / DEL / C1 control character. */
function hasBlankOrControl(value: string): boolean {
  if (/\s/u.test(value)) return true;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * An `https://` absolute address with a non-empty host part, kept exactly as given: no URL
 * parsing or normalisation, so the upstream string is passed on character for character.
 */
function isImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length > MAX_ITEM_IMAGE_URL_LENGTH || !value.startsWith(HTTPS)) return false;
  if (hasBlankOrControl(value)) return false;
  const authority = value.slice(HTTPS.length).split(/[/?#]/u, 1)[0] ?? '';
  return authority !== '';
}

export function normalizeItemImages(raw: RawItemImages): ItemImages {
  const out: { main_image_url?: string; image_urls?: readonly string[] } = {};
  const main = raw.main_image_url;
  if (isImageUrl(main)) out.main_image_url = main;
  const list = raw.image_urls;
  if (Array.isArray(list)) {
    const seen = new Set<string>();
    for (const entry of list as readonly unknown[]) {
      if (seen.size >= MAX_ITEM_IMAGES) break;
      if (isImageUrl(entry)) seen.add(entry);
    }
    // Dedup by exact string only; Set keeps first-occurrence order.
    if (seen.size > 0) out.image_urls = Object.freeze([...seen]);
  }
  return Object.freeze(out);
}
