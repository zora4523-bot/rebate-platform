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

export function normalizeItemImages(raw: RawItemImages): ItemImages {
  void raw;
  throw new Error('NotImplemented: normalizeItemImages');
}
