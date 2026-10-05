import type { ClientPlatform } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Clock } from '../../platform/index.ts';
import { CONTENT_CACHE_TTL_MS } from '../domain/cache-policy.ts';
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

/**
 * ContentReader with both reads cached for CONTENT_CACHE_TTL_MS (rule in TtlCache). Minimum
 * versions are cached per (appId, platform) with every channel of that platform, so the cache
 * holds only rows that exist however many distinct channels callers ask for; missing config keys
 * are cached like present ones. One instance per process shares its cache across requests.
 */
export class CachedContentReader implements ContentReader {
  private readonly store: ContentStore;
  private readonly versions: TtlCache<ReadonlyMap<string, string | null>>;
  private readonly configs: TtlCache<ContentConfig | null>;

  constructor(store: ContentStore, clock: Clock) {
    this.store = store;
    this.versions = new TtlCache(clock, CONTENT_CACHE_TTL_MS);
    this.configs = new TtlCache(clock, CONTENT_CACHE_TTL_MS);
  }

  async minSupportedVersion(
    appId: string,
    platform: ClientPlatform,
    channel: string,
  ): Promise<string | null> {
    if (!isVersionGatedPlatform(platform)) return null;
    const byChannel = await this.versions.get(cacheKey(appId, platform), () =>
      this.store.minSupportedVersionsByChannel(appId, platform),
    );
    return byChannel.get(channel) ?? null;
  }

  async configValue(appId: string, key: string): Promise<ContentConfig | null> {
    const config = await this.configs.get(cacheKey(appId, key), () =>
      this.store.configItem(appId, key),
    );
    if (config === null) return null;
    // Every caller gets its own copy: the cached value is shared by all later reads.
    return { value: structuredClone(config.value), version: config.version };
  }
}

/** Unambiguous key for any pair of strings (no separator can collide). */
function cacheKey(first: string, second: string): string {
  return JSON.stringify([first, second]);
}
