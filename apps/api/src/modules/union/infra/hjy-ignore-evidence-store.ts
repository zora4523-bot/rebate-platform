// Private storage of the 花卷云 ignore screenshots (B1-22h; BR-ATTR-02 细则: PNG / JPEG ≤ 5 MB in
// the private OSS bucket; BR-ATTR-28; contract adminActivateUnionPid). The object key is also
// written to union_pids.hjy_ignore_evidence_path; no public URL exists (viewing is not part of the
// contract). Activation stores the screenshot first and writes the row only after `put` succeeded,
// so a failing store changes no row.
//
// Neither platform store fits: MEDIA_STORE is the public, content-addressed media bucket, and
// EXPORT_STORE only takes `<app_id>/<export_id>.csv`. So, as those two before their OSS adapter:
// local / test keep the objects in process memory; every other environment constructs and then
// refuses each put (HjyIgnoreEvidenceStoreUnavailableError, a plain Error the global filter answers
// with HTTP 500 / 50001) with a warn event, so an activation fails closed instead of pointing at a
// screenshot that was never kept.
// TODO(规划/11 §4.5): 截图写入 OSS 私有 bucket 的真实适配器 — blocked on OSS 适配器（B1-30）与私有 bucket 配置
// Logs carry the key only, never the content.
import type { AppEnv, RootLogger } from '../../platform/index.ts';

export interface HjyIgnoreEvidencePut {
  /** Private object key, also persisted as union_pids.hjy_ignore_evidence_path. */
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly contentType: 'image/png' | 'image/jpeg';
}

export interface HjyIgnoreEvidenceStoreOptions {
  readonly appEnv: AppEnv;
  readonly logger: RootLogger;
}

/** No usable private bucket in this environment; deliberately without a business code (50001). */
export class HjyIgnoreEvidenceStoreUnavailableError extends Error {
  constructor() {
    super('HJY ignore evidence store is unavailable');
    this.name = 'HjyIgnoreEvidenceStoreUnavailableError';
  }
}

/** `union-pids/<pid_id>/<object id>.<png|jpg>` (lower-case UUIDs). */
const KEY =
  /^union-pids\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg)$/;

function check(input: HjyIgnoreEvidencePut): void {
  if (typeof input.key !== 'string' || !KEY.test(input.key)) {
    throw new TypeError('evidence key must be union-pids/<pid_id>/<uuid>.<png|jpg>');
  }
  if (input.contentType !== 'image/png' && input.contentType !== 'image/jpeg') {
    throw new TypeError('evidence contentType must be image/png or image/jpeg');
  }
  if (!(input.bytes instanceof Uint8Array)) throw new TypeError('evidence bytes must be bytes');
}

/** B1-22h: activation's private storage boundary; tests replace only this external write. */
export class HjyIgnoreEvidenceStore {
  readonly #memory: Map<string, { bytes: Uint8Array; contentType: string }> | null;
  readonly #logger: RootLogger;

  constructor(options: HjyIgnoreEvidenceStoreOptions) {
    this.#memory = options.appEnv === 'local' || options.appEnv === 'test' ? new Map() : null;
    this.#logger = options.logger;
  }

  put(input: HjyIgnoreEvidencePut): Promise<void> {
    try {
      check(input);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (this.#memory === null) {
      this.#logger.warn(
        { event: 'hjy_evidence_store_unavailable', key: input.key },
        'HJY ignore evidence store has no private bucket; activation refused',
      );
      return Promise.reject(new HjyIgnoreEvidenceStoreUnavailableError());
    }
    // A copy of the view's own bytes: later changes by the caller never reach the object.
    this.#memory.set(input.key, {
      bytes: new Uint8Array(input.bytes),
      contentType: input.contentType,
    });
    this.#logger.debug({ event: 'hjy_evidence_stored', key: input.key }, 'evidence stored');
    return Promise.resolve();
  }

  /** local / test read-back (a copy); undefined for an absent key or without the memory store. */
  get(key: string): { readonly bytes: Uint8Array; readonly contentType: string } | undefined {
    const object = this.#memory?.get(key);
    return object === undefined
      ? undefined
      : { bytes: new Uint8Array(object.bytes), contentType: object.contentType };
  }
}
