// GET /v1/pages/{page_key} (task F1-09d; 规划/04 §6.2, §3.2; 08 BR-ID-11 细则「首页人群与灰度」;
// 03 §6.1). Reads the page pointer and the chosen version through per-process TTL caches keyed by
// (app_id, page_key[, version]) on the injected Clock; the version is picked and the sections are
// filtered on every request (F1-09b's pure functions), so nothing that depends on the caller is
// ever cached.
import type { Schema } from '@couli/contracts-ts';
import type { Clock } from '../../platform/index.ts';
import { CONTENT_CACHE_TTL_MS } from '../domain/cache-policy.ts';
import {
  pickPageVersion,
  selectSections,
  type PagePointer,
  type PageViewer,
} from '../domain/pages/select/index.ts';
import { TtlCache } from './ttl-cache.ts';

/** Server constant of the response's ttl_sec (03 §6.1 example; 编排者默认 R8, contract getPage). */
export const PAGE_TTL_SEC = 300;

const PUBLISHED = 'published';

export interface PageVersion {
  readonly status: string;
  readonly sections: readonly Record<string, unknown>[];
}

export interface PageStore {
  pointer(appId: string, pageKey: string): Promise<PagePointer | null>;
  version(appId: string, pageKey: string, version: number): Promise<PageVersion | null>;
}

function cacheKey(...parts: readonly (string | number)[]): string {
  return JSON.stringify(parts);
}

export class PageReader {
  readonly #store: PageStore | null;
  readonly #pointers: TtlCache<PagePointer | null>;
  readonly #versions: TtlCache<PageVersion | null>;

  constructor(store: PageStore | null, clock: Clock) {
    this.#store = store;
    this.#pointers = new TtlCache(clock, CONTENT_CACHE_TTL_MS);
    this.#versions = new TtlCache(clock, CONTENT_CACHE_TTL_MS);
  }

  /**
   * The page as served to this request, or null when it is not deliverable (no page row, no
   * pointer for this device, or the chosen version missing or not published; the caller answers
   * 30701). A device id that is null or empty gets the full version. Rejects without a database.
   */
  async read(
    appId: string,
    pageKey: string,
    deviceId: string | null,
    viewer: PageViewer,
  ): Promise<Schema<'Page'> | null> {
    const store = this.#available();
    const pointer = await this.#pointers.get(cacheKey(appId, pageKey), () =>
      store.pointer(appId, pageKey),
    );
    if (pointer === null) return null;
    const chosen = pickPageVersion({
      appId,
      deviceId: deviceId === '' ? null : deviceId,
      page: pointer,
    });
    if (chosen === null) return null;
    const version = await this.#versions.get(cacheKey(appId, pageKey, chosen), () =>
      store.version(appId, pageKey, chosen),
    );
    // Never fall back to another version: a pointer at a draft or rolled-back version serves none.
    if (version === null || version.status !== PUBLISHED || !Array.isArray(version.sections)) {
      return null;
    }
    return {
      page_key: pageKey,
      version: chosen,
      ttl_sec: PAGE_TTL_SEC,
      sections: selectSections(version.sections, viewer) as Record<string, unknown>[],
    };
  }

  #available(): PageStore {
    if (this.#store === null) throw new Error('content: page reads need the database');
    return this.#store;
  }
}
