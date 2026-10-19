// F1-02n §9.2 裁定 3 (L43): the H5 address of an agreement's full text, built once at publish
// time (F1-02p) and stored in agreements.url; readers only read the stored column. Pure.
import type { AgreementType } from './index.ts';

/**
 * `<base>/agreement?type=<type>&version=<n>` (routes.json `Agreement`, parameter order fixed).
 * The base must be an absolute https address without query or fragment; one trailing `/` is
 * dropped. Any other base gives null (the publisher answers 50001).
 */
export function agreementTextUrl(
  h5BaseUrl: string,
  type: AgreementType,
  version: number,
): string | null {
  if (!h5BaseUrl.startsWith('https://')) return null;
  if (h5BaseUrl.includes('?') || h5BaseUrl.includes('#')) return null;
  let parsed: URL;
  try {
    parsed = new URL(h5BaseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname === '') return null;
  if (!Number.isInteger(version) || version < 1) return null;
  const base = h5BaseUrl.endsWith('/') ? h5BaseUrl.slice(0, -1) : h5BaseUrl;
  return `${base}/agreement?type=${type}&version=${version}`;
}
