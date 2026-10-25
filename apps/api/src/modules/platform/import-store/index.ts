// Private import store port (B1-09g; 08 BR-FUND-06 细则「维权导入任务」, BR-ATTR-26 细则「渠道单导入」;
// after the export-store precedent of ../export-store/index.ts). The admin upload of POST
// /admin/v1/rights-imports puts the xlsx here; the worker's rights_import job reads it back. Files
// are never public: no URL is ever produced.
// Key: `<app_id>/<import_id>.xlsx` (app_id as the contract's AppId, import_id a lower-case UUID);
// rights_imports.file_path holds the key. put overwrites idempotently; get of a missing key is
// null; delete of a missing key succeeds.
// local / test: in-process memory stand-in that keeps a private copy of the bytes (later changes of
// the caller's buffer, or of what get returned, never reach the stored file). staging / prod: until
// the OSS adapter lands, construction succeeds and every put / get fails per request, as the export
// store does.
// TODO(规划/11 §3.2): OSS `imports` private bucket adapter — blocked on B1-30.
// Logs carry the key only, never the bytes, the cell contents or the client's filename.
// Erasable syntax only (also compiled by the `test` project).
import type { AppEnv } from '../config/index.ts';
import type { RootLogger } from '../logging/index.ts';

export type ImportContentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface ImportPutInput {
  /** `<app_id>/<import_id>.xlsx`. */
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly contentType: ImportContentType;
}

export interface ImportStore {
  /** Idempotent overwrite; returns nothing that would reach the file from outside. */
  put(input: ImportPutInput): Promise<void>;
  /** A fresh copy of the stored bytes, or null when nothing is stored under the key. */
  get(key: string): Promise<Uint8Array | null>;
  /** Deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
}

export interface MemoryImportStoreOptions {
  readonly logger: RootLogger;
}

export interface ImportStoreOptions {
  readonly appEnv: AppEnv;
  readonly logger: RootLogger;
}

/**
 * The import store has no usable backend in this environment (staging / prod without the OSS
 * adapter). A plain Error without a business code: the global exception filter answers 50001.
 */
export class ImportStoreUnavailableError extends Error {
  constructor() {
    super('Import store adapter is unavailable');
    this.name = 'ImportStoreUnavailableError';
  }
}

// app_id: contracts/openapi.yaml AppId (^[a-z0-9_]+$, 1..32); import_id: a lower-case UUID.
const IMPORT_KEY =
  /^[a-z0-9_]{1,32}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.xlsx$/;
const CONTENT_TYPE: ImportContentType =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !IMPORT_KEY.test(key)) {
    throw new TypeError('import key must be <app_id>/<import_id>.xlsx');
  }
}

function checkPut(input: ImportPutInput): void {
  assertKey(input.key);
  if (input.contentType !== CONTENT_TYPE) throw new TypeError('import contentType must be xlsx');
  if (!(input.bytes instanceof Uint8Array))
    throw new TypeError('import bytes must be a Uint8Array');
}

function rejectWith<T>(error: unknown): Promise<T> {
  return Promise.reject(error instanceof Error ? error : new Error(String(error)));
}

/** local / test stand-in: the files live in this object only. */
export class MemoryImportStore implements ImportStore {
  readonly #logger: RootLogger;
  readonly #files = new Map<string, Uint8Array>();

  constructor(options: MemoryImportStoreOptions) {
    this.#logger = options.logger;
  }

  put(input: ImportPutInput): Promise<void> {
    try {
      checkPut(input);
      // A fresh copy of only the view's own bytes: later changes by the caller never reach it.
      this.#files.set(input.key, new Uint8Array(input.bytes));
      this.#logger.debug({ event: 'import_store_put', key: input.key }, 'import stored');
      return Promise.resolve();
    } catch (error) {
      return rejectWith(error);
    }
  }

  get(key: string): Promise<Uint8Array | null> {
    try {
      assertKey(key);
      const bytes = this.#files.get(key);
      // A fresh copy per read: changing what one read returned never reaches the stored file.
      return Promise.resolve(bytes === undefined ? null : new Uint8Array(bytes));
    } catch (error) {
      return rejectWith(error);
    }
  }

  delete(key: string): Promise<void> {
    try {
      assertKey(key);
      this.#files.delete(key);
      this.#logger.debug({ event: 'import_store_deleted', key }, 'import deleted');
      return Promise.resolve();
    } catch (error) {
      return rejectWith(error);
    }
  }
}

/** staging / prod before the OSS adapter (B1-30): constructs, then every put and get fails. */
class UnavailableImportStore implements ImportStore {
  readonly #logger: RootLogger;

  constructor(logger: RootLogger) {
    this.#logger = logger;
  }

  put(input: ImportPutInput): Promise<void> {
    try {
      checkPut(input);
    } catch (error) {
      return rejectWith(error);
    }
    return this.#refuse('put', input.key);
  }

  get(key: string): Promise<Uint8Array | null> {
    try {
      assertKey(key);
    } catch (error) {
      return rejectWith(error);
    }
    return this.#refuse('get', key);
  }

  delete(key: string): Promise<void> {
    try {
      assertKey(key);
      return Promise.resolve();
    } catch (error) {
      return rejectWith(error);
    }
  }

  #refuse<T>(operation: 'put' | 'get', key: string): Promise<T> {
    this.#logger.warn(
      { event: 'import_store_unavailable', operation, key },
      'import store adapter is not configured; request refused',
    );
    return Promise.reject(new ImportStoreUnavailableError());
  }
}

/** local / test: memory; staging / prod: construction succeeds, put and get fail until B1-30. */
export function createImportStore(options: ImportStoreOptions): ImportStore {
  if (options.appEnv === 'local' || options.appEnv === 'test') {
    return new MemoryImportStore({ logger: options.logger });
  }
  return new UnavailableImportStore(options.logger);
}
