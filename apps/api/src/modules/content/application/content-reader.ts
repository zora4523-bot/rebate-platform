import type { ClientPlatform } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Clock } from '../../platform/index.ts';
import { CONTENT_CACHE_TTL_MS, switchCacheTtlMs } from '../domain/cache-policy.ts';
import { switchSpecOf } from '../domain/switch-registry.ts';
import type { AppVersionRow } from '../domain/app-version.ts';
import { isVersionGatedPlatform } from '../domain/version-gate.ts';
import { TtlCache } from './ttl-cache.ts';

/** A config_items value: any JSON, including null. */
export type ConfigValue = DB['config_items']['value'];

/** A config_items row as read: its value with the business version (not row_version). */
export interface ContentConfig {
  readonly value: ConfigValue;
  readonly version: number;
}

/**
 * Read-only access to the minimum supported version and to business configuration.
 * `appId` is supplied by the caller (the token's app_id, or an X-App-Id already validated per
 * BR-ID-01 ③). Both reads reject when the database read fails; they never answer with null or
 * with an expired value instead.
 */
export interface ContentReader {
  /** Exact row, on every platform; absent channel/row means null, never a fallback. */
  appVersion(
    appId: string,
    platform: ClientPlatform,
    channel: string | null,
  ): Promise<AppVersionRow | null>;
  /**
   * min_supported_version of the app_versions row of (appId, platform, channel). null when the
   * platform is not judged (h5, admin: the database is not read), when that row does not exist
   * or when it sets no minimum.
   */
  minSupportedVersion(
    appId: string,
    platform: ClientPlatform,
    channel: string,
  ): Promise<string | null>;
  /** The config_items value and version of (appId, key); null when the key does not exist. */
  configValue(appId: string, key: string): Promise<ContentConfig | null>;
}

/** Read port over app_versions and config_items, implemented in infra/. */
export interface ContentStore {
  /** channel → min_supported_version of every app_versions row of (appId, platform). */
  minSupportedVersionsByChannel(
    appId: string,
    platform: ClientPlatform,
  ): Promise<ReadonlyMap<string, string | null>>;
  /** The config_items row of (appId, key), or null when there is none. */
  configItem(appId: string, key: string): Promise<ContentConfig | null>;
}

/** Optional full-row read port; existing ContentStore implementations remain compatible. */
export interface AppVersionRowStore {
  /** channel → full app_versions row of (appId, platform). */
  appVersionsByChannel(
    appId: string,
    platform: ClientPlatform,
  ): Promise<ReadonlyMap<string, AppVersionRow>>;
}

/**
 * ContentReader with registered switches cached for switchCacheTtlMs() and other reads for
 * CONTENT_CACHE_TTL_MS (rule in TtlCache). Whole version
 * rows are cached per (appId, platform), shared by both version reads, so the cache
 * holds only rows that exist however many distinct channels callers ask for; missing config keys
 * are cached like present ones. One instance per process shares its cache across requests.
 */
export class CachedContentReader implements ContentReader {
  private readonly store: ContentStore;
  private readonly rowStore: AppVersionRowStore | undefined;
  private readonly versions: TtlCache<ReadonlyMap<string, AppVersionRow>>;
  private readonly minimumVersions: TtlCache<ReadonlyMap<string, string | null>>;
  private readonly configs: TtlCache<ContentConfig | null>;
  private readonly switches: TtlCache<ContentConfig | null>;

  constructor(store: ContentStore, clock: Clock, rowStore?: AppVersionRowStore) {
    this.store = store;
    this.rowStore = rowStore;
    this.versions = new TtlCache(clock, CONTENT_CACHE_TTL_MS);
    this.minimumVersions = new TtlCache(clock, CONTENT_CACHE_TTL_MS);
    this.configs = new TtlCache(clock, CONTENT_CACHE_TTL_MS);
    this.switches = new TtlCache(clock, switchCacheTtlMs());
  }

  async minSupportedVersion(
    appId: string,
    platform: ClientPlatform,
    channel: string,
  ): Promise<string | null> {
    if (!isVersionGatedPlatform(platform)) return null;
    if (this.rowStore === undefined) {
      const byChannel = await this.minimumVersions.get(cacheKey(appId, platform), () =>
        this.store.minSupportedVersionsByChannel(appId, platform),
      );
      return byChannel.get(channel) ?? null;
    }
    const byChannel = await this.versionRows(appId, platform);
    return byChannel.get(channel)?.min_supported_version ?? null;
  }

  async appVersion(
    appId: string,
    platform: ClientPlatform,
    channel: string | null,
  ): Promise<AppVersionRow | null> {
    if (channel === null) return null;
    const row = (await this.versionRows(appId, platform)).get(channel);
    return row === undefined ? null : structuredClone(row);
  }

  private versionRows(appId: string, platform: ClientPlatform) {
    const rowStore = this.rowStore;
    if (rowStore === undefined) {
      throw new Error('content: full version reads need the app version row store');
    }
    return this.versions.get(cacheKey(appId, platform), () =>
      rowStore.appVersionsByChannel(appId, platform),
    );
  }

  async configValue(appId: string, key: string): Promise<ContentConfig | null> {
    const cache = switchSpecOf(key) === null ? this.configs : this.switches;
    const config = await cache.get(cacheKey(appId, key), () => this.store.configItem(appId, key));
    if (config === null) return null;
    // Every caller gets its own copy: the cached value is shared by all later reads.
    return { value: structuredClone(config.value), version: config.version };
  }
}

/** Unambiguous key for any pair of strings (no separator can collide). */
function cacheKey(first: string, second: string): string {
  return JSON.stringify([first, second]);
}
