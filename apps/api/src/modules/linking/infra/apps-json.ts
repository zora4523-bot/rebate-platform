// B1-06w: contracts/apps.json, read once when the entry starts (the jump plan's app schemes and
// their status; 规划/04 §9). A malformed file stops the entry rather than guessing a scheme.
import { readFileSync } from 'node:fs';
import type { LinkOpenApps } from '../application/link-open-conversion.ts';

/** Resolves to the repository root from both src/ and dist/ (same depth). */
export const APPS_JSON_FILE = new URL('../../../../../../contracts/apps.json', import.meta.url);

function strings(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`contracts/apps.json: ${where} must be an array of strings`);
  }
  return value;
}

/** Validates the two platforms the open converts (jd, pdd); the rest of the file is kept. */
export function parseLinkOpenApps(document: unknown): LinkOpenApps {
  const apps =
    typeof document === 'object' && document !== null
      ? (document as { apps?: unknown }).apps
      : undefined;
  if (typeof apps !== 'object' || apps === null) {
    throw new Error('contracts/apps.json: apps must be an object');
  }
  for (const platform of ['jd', 'pdd'] as const) {
    const entry = (apps as Record<string, unknown>)[platform] as
      { status?: unknown; ios?: unknown; android?: unknown; harmony?: unknown } | undefined;
    if (typeof entry !== 'object' || entry === null || typeof entry.status !== 'string') {
      throw new Error(`contracts/apps.json: apps.${platform} needs a status`);
    }
    strings(
      (entry.ios as { query_schemes?: unknown } | undefined)?.query_schemes,
      `${platform}.ios`,
    );
    strings((entry.android as { packages?: unknown } | undefined)?.packages, `${platform}.android`);
    strings(
      (entry.harmony as { query_schemes?: unknown } | undefined)?.query_schemes,
      `${platform}.harmony`,
    );
  }
  return document as LinkOpenApps;
}

export function loadLinkOpenApps(file: URL = APPS_JSON_FILE): LinkOpenApps {
  return parseLinkOpenApps(JSON.parse(readFileSync(file, 'utf8')) as unknown);
}
