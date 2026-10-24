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

/** local / test stand-in: the files live in this object only. */
export class MemoryImportStore implements ImportStore {
  constructor(options: MemoryImportStoreOptions) {
    void options;
    throw new Error('NotImplemented: MemoryImportStore');
  }

  put(input: ImportPutInput): Promise<void> {
    void input;
    throw new Error('NotImplemented: MemoryImportStore.put');
  }

  get(key: string): Promise<Uint8Array | null> {
    void key;
    throw new Error('NotImplemented: MemoryImportStore.get');
  }

  delete(key: string): Promise<void> {
    void key;
    throw new Error('NotImplemented: MemoryImportStore.delete');
  }
}

/** local / test: memory; staging / prod: construction succeeds, put and get fail until B1-30. */
export function createImportStore(options: ImportStoreOptions): ImportStore {
  void options;
  throw new Error('NotImplemented: createImportStore');
}
