// GET /v1/dict (F1-02s; 08 BR-TEXT-12; contract getDict). The current version is config_items
// `dict_version`, judged exactly like /v1/config's data.dict_version (missing or non-string: "0"),
// so the two always agree. Only a canonical positive int32 string reads dict_items: each
// (dict, code) takes its highest version ≤ that number and keys whose text is null are left out.
// The version and the rows come from one database snapshot (DictStore.snapshot), never from two
// independent reads, so a concurrent publish cannot pair a new version with old texts.
// Cached per app_id for CONTENT_CACHE_TTL_MS on the injected Clock (L11); the query's `version`
// hint never reaches this class (L13: always the whole current dictionary).
//
// Pure module (no decorators, erasable syntax).
import type { Schema } from '@couli/contracts-ts';
import type { Logger } from 'pino';
import type { Clock } from '../../platform/index.ts';
import { CONTENT_CACHE_TTL_MS } from '../domain/cache-policy.ts';
import { dictItems, parseDictVersion, type CurrentDictRow } from '../domain/dict/index.ts';
import { TtlCache } from './ttl-cache.ts';

export interface DictSnapshot {
  /** config_items.value of `dict_version` (undefined: no row). */
  readonly value: unknown;
  /** Current rows ≤ the limit chosen for `value`; empty when that limit is null. */
  readonly rows: readonly CurrentDictRow[];
}

export interface DictStore {
  /**
   * Reads the app's `dict_version` and then, when `limitOf(value)` is not null, the current
   * dict_items rows with version ≤ that limit, both inside one snapshot.
   */
  snapshot(appId: string, limitOf: (value: unknown) => number | null): Promise<DictSnapshot>;
}

export class DictReader {
  readonly #store: DictStore | null;
  readonly #cache: TtlCache<Schema<'Dict'>>;
  readonly #logger: Pick<Logger, 'warn'>;

  constructor(store: DictStore | null, clock: Clock, logger: Pick<Logger, 'warn'>) {
    this.#store = store;
    this.#cache = new TtlCache(clock, CONTENT_CACHE_TTL_MS);
    this.#logger = logger;
  }

  read(appId: string): Promise<Schema<'Dict'>> {
    const store = this.#store;
    if (store === null) {
      return Promise.reject(new Error('content: dictionary reads need the database'));
    }
    return this.#cache.get(appId, () => this.#load(store, appId));
  }

  async #load(store: DictStore, appId: string): Promise<Schema<'Dict'>> {
    const { value, rows } = await store.snapshot(appId, (raw) => parseDictVersion(raw).limit);
    const { version, limit } = parseDictVersion(value);
    if (limit === null) {
      // "0" (missing row included) is the unpublished sentinel; anything else is malformed and
      // still answered as is with no texts, matching /v1/config (编排默认, L47).
      if (value !== undefined && value !== '0') {
        this.#logger.warn(
          { event: 'content_dict_version_invalid', app_id: appId, config_key: 'dict_version' },
          'dictionary version is not a published version; empty dictionary served',
        );
      }
      return { version, items: {} };
    }
    return { version, items: dictItems(rows) };
  }
}
