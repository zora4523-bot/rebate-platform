import ajvFormats from 'ajv-formats';
import type { Schema } from '@couli/contracts-ts';

export type AppVersionCheck = Schema<'AppVersionCheck'>;

/** Raw business columns; JSON listings still need validation before publication. */
export interface AppVersionRow {
  readonly latest_version: string;
  readonly min_supported_version: string | null;
  readonly recommended_version: string | null;
  readonly update_title: string;
  readonly update_notes: string;
  readonly store_url: string;
  readonly default_store: string;
  readonly store_listings: unknown;
}

// contracts/openapi.yaml: SemVer (x.y.z only) and format: uri.
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const isUri = ajvFormats.default.get('uri') as (value: string) => boolean;

export class InvalidAppVersionError extends Error {
  readonly column: keyof AppVersionRow;

  constructor(column: keyof AppVersionRow) {
    // Do not put column values into exceptions: the HTTP filter logs unexpected errors.
    super(`content: malformed app_versions column ${column}`);
    this.name = 'InvalidAppVersionError';
    this.column = column;
  }
}

/** Preserve row values and listing order, exposing only contract fields. */
export function buildAppVersionCheck(row: AppVersionRow): AppVersionCheck {
  if (!isUri(row.store_url)) throw new InvalidAppVersionError('store_url');
  if (row.default_store.length === 0) throw new InvalidAppVersionError('default_store');
  if (!Array.isArray(row.store_listings)) throw new InvalidAppVersionError('store_listings');

  const stores: AppVersionCheck['stores'] = [];
  const seen = new Set<string>();
  for (const item of row.store_listings) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new InvalidAppVersionError('store_listings');
    }
    const listing = item as Record<string, unknown>;
    const store = listing['store'];
    const version = listing['listed_version'] ?? null;
    if (
      typeof store !== 'string' ||
      store.length === 0 ||
      seen.has(store) ||
      (version !== null && (typeof version !== 'string' || !SEMVER.test(version)))
    ) {
      throw new InvalidAppVersionError('store_listings');
    }
    seen.add(store);
    stores.push({ store, listed_version: version });
  }
  if (!seen.has(row.default_store)) {
    stores.push({ store: row.default_store, listed_version: null });
  }

  return {
    latest_version: row.latest_version,
    min_supported_version: row.min_supported_version,
    recommended_version: row.recommended_version,
    update_title: row.update_title,
    update_notes: row.update_notes,
    store_url: row.store_url,
    default_store: row.default_store,
    stores,
  };
}
