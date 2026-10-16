// Admin reads of the platform mark replacement images (F1-06w; contract adminListPlatformIcons,
// adminListPlatformIconVersions; 08 BR-TEXT-24 细则; 04 §11.2 content.platform_icon). The
// permission point is checked by the controller through platform's AdminOperationGuard before any
// call here; the app is the verified admin's. Reads only: no cache, no write, no audit row.
// A version's url is derived from MEDIA_PUBLIC_BASE_URL and its digest (platform mediaUrlOf);
// without a configured base (staging / prod) a response that carries a version fails with
// MediaStoreUnavailableError (HTTP 500 / 50001), and a response without one still answers.
//
// Pure module (no decorators, erasable syntax).
import { platform_icon_key, type Schema } from '@couli/contracts-ts';
import { mediaUrlOf, type MediaFormat } from '../../platform/index.ts';

type Key = Schema<'PlatformIconKey'>;
type Icon = Schema<'AdminPlatformIcon'>;
type Version = Schema<'AdminPlatformIconVersion'>;

/** One saved version as stored (platform_icon_versions). */
export interface PlatformIconVersionRow {
  readonly version: number;
  readonly sha256: string;
  readonly format: string;
  readonly bytes: number;
  readonly sanitized: boolean;
  readonly sourceUrl: string | null;
  /** Calendar date `YYYY-MM-DD`, as stored. */
  readonly downloadedOn: string | null;
  readonly everPublished: boolean;
  readonly revision: number;
  /** Username snapshot taken when the version was saved. */
  readonly createdBy: string;
  readonly createdAt: Date;
}

/** One mark of the app that has a platform_icons row, with its current and newest versions. */
export interface PlatformIconRow {
  readonly key: string;
  readonly currentVersion: number | null;
  readonly revision: number;
  readonly updatedBy: string | null;
  readonly updatedAt: Date | null;
  /** The published version's row; null when the mark shows the built-in image. */
  readonly current: PlatformIconVersionRow | null;
}

export interface PlatformIconStore {
  /** The app's platform_icons rows (any key order). */
  icons(appId: string): Promise<readonly PlatformIconRow[]>;
  /** Highest saved version number per key of the app (drafts included); absent: none saved. */
  latestVersions(appId: string): Promise<ReadonlyMap<string, number>>;
  /** Saved versions of one mark, version descending, and their total count. */
  versionPage(
    appId: string,
    key: Key,
    offset: number,
    limit: number,
  ): Promise<{ readonly total: number; readonly items: readonly PlatformIconVersionRow[] }>;
}

export interface PlatformIconPageQuery {
  readonly page?: unknown;
  readonly page_size?: unknown;
}

export const PLATFORM_ICON_PAGE_DEFAULT = 1;
export const PLATFORM_ICON_PAGE_SIZE_DEFAULT = 20;
export const PLATFORM_ICON_PAGE_SIZE_MAX = 200;

/** 20001 with data.fields; the controller maps it to the contract's error envelope. */
export class PlatformIconFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`platform icon read: invalid ${fields.join(', ')}`);
    this.name = 'PlatformIconFieldsError';
    this.fields = fields;
  }
}

const KEYS: readonly Key[] = platform_icon_key;

export function isPlatformIconKey(value: unknown): value is Key {
  return typeof value === 'string' && (KEYS as readonly string[]).includes(value);
}

/** Absent → fallback; otherwise an integer within [min, max] (a numeric string is accepted). */
function pageParam(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

export function formatOf(format: string): MediaFormat {
  if (format !== 'svg' && format !== 'png') {
    throw new Error(`platform icon read: stored format ${format} is neither svg nor png`);
  }
  return format;
}

export class PlatformIconReader {
  readonly #store: PlatformIconStore;
  readonly #mediaPublicBaseUrl: string | undefined;

  constructor(store: PlatformIconStore, mediaPublicBaseUrl: string | undefined) {
    this.#store = store;
    this.#mediaPublicBaseUrl = mediaPublicBaseUrl;
  }

  /** Every key of enum platform_icon_key once, in enum order; keys without a row are built-in. */
  async list(appId: string): Promise<Schema<'AdminPlatformIconList'>> {
    const [rows, latest] = await Promise.all([
      this.#store.icons(appId),
      this.#store.latestVersions(appId),
    ]);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return {
      items: KEYS.map((key): Icon =>
        platformIconOf(key, byKey.get(key), latest.get(key) ?? null, this.#mediaPublicBaseUrl),
      ),
    };
  }

  /** One page of a mark's saved versions, newest first; 20001 for a bad key, page or size. */
  async versions(
    appId: string,
    key: string,
    query: PlatformIconPageQuery,
  ): Promise<Schema<'AdminPlatformIconVersionPage'>> {
    if (!isPlatformIconKey(key)) throw new PlatformIconFieldsError(['key']);
    const page = pageParam(query.page, PLATFORM_ICON_PAGE_DEFAULT, 1, 2 ** 31 - 1);
    const pageSize = pageParam(
      query.page_size,
      PLATFORM_ICON_PAGE_SIZE_DEFAULT,
      1,
      PLATFORM_ICON_PAGE_SIZE_MAX,
    );
    const invalid = [
      ...(page === null ? ['page'] : []),
      ...(pageSize === null ? ['page_size'] : []),
    ];
    if (page === null || pageSize === null) throw new PlatformIconFieldsError(invalid);
    const { total, items } = await this.#store.versionPage(
      appId,
      key,
      (page - 1) * pageSize,
      pageSize,
    );
    return {
      items: items.map((row) => platformIconVersionOf(row, this.#mediaPublicBaseUrl)),
      page,
      page_size: pageSize,
      total,
    };
  }
}

/** One mark as the console shows it; no row means the built-in image at revision 0. */
export function platformIconOf(
  key: Key,
  row: PlatformIconRow | undefined,
  latestVersion: number | null,
  mediaPublicBaseUrl: string | undefined,
): Icon {
  if (row === undefined) {
    return {
      key,
      current_version: null,
      revision: 0,
      current: null,
      latest_version: latestVersion,
      updated_by: null,
      updated_at: null,
    };
  }
  return {
    key,
    current_version: row.currentVersion,
    revision: row.revision,
    current: row.current === null ? null : platformIconVersionOf(row.current, mediaPublicBaseUrl),
    latest_version: latestVersion,
    updated_by: row.updatedBy,
    updated_at: row.updatedAt === null ? null : row.updatedAt.toISOString(),
  };
}

/** One saved version as the console shows it; url from MEDIA_PUBLIC_BASE_URL and the digest. */
export function platformIconVersionOf(
  row: PlatformIconVersionRow,
  mediaPublicBaseUrl: string | undefined,
): Version {
  const format = formatOf(row.format);
  return {
    version: row.version,
    url: mediaUrlOf(mediaPublicBaseUrl, row.sha256, format),
    sha256: row.sha256,
    format,
    bytes: row.bytes,
    sanitized: row.sanitized,
    source_url: row.sourceUrl,
    downloaded_on: row.downloadedOn,
    publishable: row.sourceUrl !== null && row.downloadedOn !== null,
    ever_published: row.everPublished,
    revision: row.revision,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
  };
}
