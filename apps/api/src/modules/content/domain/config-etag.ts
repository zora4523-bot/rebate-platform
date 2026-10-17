// GET /v1/config validators (task F1-02h): the config_version / ETag of one caller's final data,
// the If-None-Match comparison, and features.rank_platforms derived from the material channel
// whitelist. Pure: the caller supplies the data and the whitelist.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import { createHash } from 'node:crypto';
import type { Schema } from '@couli/contracts-ts';
import type { MaterialChannelsSpec } from '../../platform/index.ts';
import { PLATFORM_CODES } from './client-config.ts';

/**
 * Canonical JSON: object keys sorted recursively by the JS default sort, arrays in order, no
 * whitespace, primitives through JSON.stringify. Follows JSON.stringify for `undefined` (an object
 * member is left out, an array item becomes null), so the text matches what the client receives.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** F1-02h §9.2-3: caller supplies final data without config_version; returns a quoted strong tag. */
export function configEtag(data: Omit<Schema<'Config'>, 'config_version'>): string {
  const digest = createHash('sha256').update(canonicalJson(data), 'utf8').digest('hex');
  return `"${digest.slice(0, 32)}"`;
}

/** A quoted opaque-tag (RFC 9110 §8.8.3 etagc, the obs-text range included). */
const OPAQUE_TAG = /^"[\x21\x23-\x7e\x80-\xff]*"$/;

/** F1-02h §9.2-4: comma-separated If-None-Match with weak comparison. */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const current = etag.startsWith('W/') ? etag.slice(2) : etag;
  return header.split(',').some((part) => {
    const item = part.trim();
    if (item === '*') return true;
    const tag = item.startsWith('W/') ? item.slice(2) : item;
    return OPAQUE_TAG.test(tag) && tag === current;
  });
}

/** F1-02h §9.2-2: selectable platforms in PlatformCode order, without duplicates. */
export function rankPlatforms(spec: MaterialChannelsSpec): Schema<'PlatformCode'>[] {
  return PLATFORM_CODES.filter((platform) =>
    spec.channels.some((channel) => channel.platform === platform && channel.selectable),
  );
}
