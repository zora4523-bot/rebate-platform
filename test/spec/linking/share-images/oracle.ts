// B1-15z oracle: the images of POST /v1/shares from the two image fields of a union detail
// (BR-ATTR-10 细则「分享页与分享赚入口页」素材图, orchestrator ruling of 15:50): main image first,
// deduplicated, at most 9, addresses as the union returned them, [] when there is none. Duplicates
// go first, so a repeated address never takes one of the 9 places.
export const MAX_IMAGES = 9;

export interface ItemImageFields {
  readonly main_image_url?: string;
  readonly image_urls?: readonly string[];
}

/** Every address the detail carries, before composing. */
export function rawUrls(item: ItemImageFields): string[] {
  return [
    ...(item.main_image_url === undefined ? [] : [item.main_image_url]),
    ...(item.image_urls ?? []),
  ];
}

/** The composed addresses, in response order. */
export function expectedUrls(item: ItemImageFields): string[] {
  return [...new Set(rawUrls(item))].slice(0, MAX_IMAGES);
}

/** The composed addresses in the contract's shape (ShareImage). */
export function expectedImages(item: ItemImageFields): { url: string }[] {
  return expectedUrls(item).map((url) => ({ url }));
}

/** True when `images` are exactly the composed images of the detail, each with only its url. */
export function sameImages(images: readonly object[], item: ItemImageFields): boolean {
  const expected = expectedImages(item);
  return (
    images.length === expected.length &&
    images.every((image, index) => {
      const keys = Object.keys(image);
      const url: unknown = Reflect.get(image, 'url');
      return keys.length === 1 && url === expected[index]?.url;
    })
  );
}
