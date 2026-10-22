// F1-09r: the save / publish check of a popup's `props.lottie` reference (contract
// adminCreatePageConfigVersion / adminPublishPageConfig; 04 §6.2 popup; 编排裁定 9.2 5). Only the
// reference is checked, never the file (it was checked by POST /admin/v1/pages/popup-assets):
// `url` must be exactly the media address of a JSON file named by `sha256`. A reference whose
// shape is wrong (url not a string, sha256 not 64 lower-case hex) is left to the home-schema
// shape check. Pure: the caller supplies the expected address.

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `sections.<i>.props.lottie` of each popup whose reference does not match `expectedUrl(sha256)`;
 * an undefined expected address (media not configured) matches nothing.
 */
export function popupLottieFields(
  sections: unknown,
  expectedUrl: (sha256: string) => string | undefined,
): string[] {
  if (!Array.isArray(sections)) return [];
  const fields: string[] = [];
  sections.forEach((section: unknown, index) => {
    if (!isRecord(section) || section['type'] !== 'popup') return;
    const props = section['props'];
    if (!isRecord(props) || !Object.hasOwn(props, 'lottie')) return;
    const lottie = props['lottie'];
    if (!isRecord(lottie)) return;
    const { url, sha256 } = lottie;
    if (typeof url !== 'string' || typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return;
    const expected = expectedUrl(sha256);
    if (expected === undefined || url !== expected) fields.push(`sections.${index}.props.lottie`);
  });
  return fields;
}
