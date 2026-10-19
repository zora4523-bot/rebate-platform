import type { Clock } from '../clock/index.ts';
import type { AppEnv } from '../config/index.ts';
import type { RootLogger } from '../logging/index.ts';

export interface ExportPutInput {
  /** `<app_id>/<export_id>.csv`; app_id follows the contract, export_id uses [A-Za-z0-9_-]+. */
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly contentType: 'text/csv';
}

export interface ExportSignedUrlInput {
  readonly key: string;
  /** A valid instant strictly later than the injected Clock's current time. */
  readonly expiresAt: Date;
}

export interface ExportSignedUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface ExportStore {
  /** Idempotent overwrite; no public URL is returned. */
  put(input: ExportPutInput): Promise<void>;
  signedUrl(input: ExportSignedUrlInput): Promise<ExportSignedUrl>;
  /** Deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
}

/** Injection token placeholder; the implementation may replace this with a Symbol. */
export class EXPORT_STORE {
  constructor() {
    throw new Error('NotImplemented: EXPORT_STORE');
  }
}

export interface MemoryExportStoreOptions {
  readonly baseUrl: string;
  readonly signingKey: string;
  readonly clock: Clock;
  readonly logger: RootLogger;
}

export interface ExportStoreOptions {
  readonly appEnv: AppEnv;
  readonly baseUrl: string | undefined;
  readonly signingKey: string | undefined;
  readonly clock: Clock;
  readonly logger: RootLogger;
}

export class ExportStoreUnavailableError extends Error {
  constructor() {
    super('Export store adapter is unavailable');
    throw new Error('NotImplemented: ExportStoreUnavailableError');
  }
}

/**
 * Local/test stand-in only. URL: <base>/<key>?expires=<epoch-ms>&signature=<hex>.
 * HMAC-SHA256 signs UTF-8 `<key>\n<epoch-ms>` with the injected signingKey.
 * verify rejects a different base, malformed/ambiguous query, bad signature or now >= expires.
 * get is test-only read-back, returning a defensive copy; it is not a public download endpoint.
 */
export class MemoryExportStore implements ExportStore {
  constructor(options: MemoryExportStoreOptions) {
    void options;
    throw new Error('NotImplemented: MemoryExportStore');
  }

  put(input: ExportPutInput): Promise<void> {
    void input;
    throw new Error('NotImplemented: MemoryExportStore.put');
  }

  signedUrl(input: ExportSignedUrlInput): Promise<ExportSignedUrl> {
    void input;
    throw new Error('NotImplemented: MemoryExportStore.signedUrl');
  }

  delete(key: string): Promise<void> {
    void key;
    throw new Error('NotImplemented: MemoryExportStore.delete');
  }

  get(key: string): { readonly bytes: Uint8Array; readonly contentType: 'text/csv' } | undefined {
    void key;
    throw new Error('NotImplemented: MemoryExportStore.get');
  }

  verify(url: string, now: Date): boolean {
    void url;
    void now;
    throw new Error('NotImplemented: MemoryExportStore.verify');
  }
}

/** local/test: memory; staging/prod: construction succeeds, requests fail until B1-30. */
export function createExportStore(options: ExportStoreOptions): ExportStore {
  void options;
  throw new Error('NotImplemented: createExportStore');
}
