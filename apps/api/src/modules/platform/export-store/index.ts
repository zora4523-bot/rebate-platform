// Private export store port (B1-34d; 08 BR-ID-34 细则「后台导出任务」: every download re-authorizes
// and gets a freshly signed link valid for min(5 minutes, remaining download window), the caller
// picks expiresAt; 02 §4: OSS `exports` bucket is private, files are reached only via signed URLs).
// Key: `<app_id>/<export_id>.csv`. put overwrites idempotently and returns no public URL;
// signedUrl returns a time-limited link; delete of a missing key succeeds.
// local / test: in-process memory stand-in whose links carry an HMAC-SHA256 signature and an expiry
// that verify() checks. staging / prod: until the OSS adapter lands (B1-30), construction succeeds
// and every put / signedUrl fails per request (ExportStoreUnavailableError, a plain Error the global
// filter maps to HTTP 500 / 50001), like the media store and the SMS sender default.
// Logs carry the key only, never the content, the URL, the signature or the signing key.
// Erasable syntax only (also compiled by the `test` project).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../clock/index.ts';
import type { AppEnv } from '../config/index.ts';
import {
  EXPORT_STORE_DEFAULT_LOCAL_BASE_URL,
  EXPORT_STORE_DEFAULT_LOCAL_SIGNING_KEY,
} from '../config/export-store.ts';
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

/** Nest injection token of the process-wide ExportStore (provided globally by PlatformModule). */
export const EXPORT_STORE = Symbol('EXPORT_STORE');

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

/**
 * The export store has no usable backend in this environment (staging / prod without the OSS
 * adapter). Deliberately a plain Error without a business code: the global exception filter answers
 * HTTP 500 / 50001.
 */
export class ExportStoreUnavailableError extends Error {
  constructor() {
    super('Export store adapter is unavailable');
    this.name = 'ExportStoreUnavailableError';
  }
}

// app_id: contracts/openapi.yaml AppId (^[a-z0-9_]+$, 1..32); export_id: [A-Za-z0-9_-]{1,128}.
const EXPORT_KEY = /^[a-z0-9_]{1,32}\/[A-Za-z0-9_-]{1,128}\.csv$/;
const EXPIRES_MS = /^(?:0|[1-9][0-9]{0,15})$/;
const SIGNATURE_HEX = /^[0-9a-f]{64}$/;
const CONTENT_TYPE = 'text/csv';

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !EXPORT_KEY.test(key)) {
    throw new TypeError('export key must be <app_id>/<export_id>.csv');
  }
}

function checkPut(input: ExportPutInput): void {
  assertKey(input.key);
  if (input.contentType !== CONTENT_TYPE)
    throw new TypeError('export contentType must be text/csv');
  if (!(input.bytes instanceof Uint8Array))
    throw new TypeError('export bytes must be a Uint8Array');
}

function validInstant(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function rejectWith<T>(error: unknown): Promise<T> {
  return Promise.reject(error instanceof Error ? error : new Error(String(error)));
}

/**
 * Local/test stand-in only. URL: <base>/<key>?expires=<epoch-ms>&signature=<hex>.
 * HMAC-SHA256 signs UTF-8 `<key>\n<epoch-ms>` with the injected signingKey.
 * verify rejects a different base, malformed/ambiguous query, bad signature or now >= expires.
 * get is test-only read-back, returning a defensive copy; it is not a public download endpoint.
 */
export class MemoryExportStore implements ExportStore {
  readonly #baseUrl: string;
  readonly #signingKey: string;
  readonly #clock: Clock;
  readonly #logger: RootLogger;
  readonly #files = new Map<string, Uint8Array>();

  constructor(options: MemoryExportStoreOptions) {
    const base = options.baseUrl.replace(/\/+$/, '');
    if (base === '') throw new TypeError('export store baseUrl must not be empty');
    if (options.signingKey === '') throw new TypeError('export store signingKey must not be empty');
    this.#baseUrl = base;
    this.#signingKey = options.signingKey;
    this.#clock = options.clock;
    this.#logger = options.logger;
  }

  put(input: ExportPutInput): Promise<void> {
    try {
      checkPut(input);
      // Copies only the view's own bytes (byteOffset / byteLength), never the backing buffer.
      this.#files.set(input.key, input.bytes.slice());
      this.#logger.debug({ event: 'export_store_put', key: input.key }, 'export stored');
      return Promise.resolve();
    } catch (error) {
      return rejectWith(error);
    }
  }

  signedUrl(input: ExportSignedUrlInput): Promise<ExportSignedUrl> {
    try {
      assertKey(input.key);
      if (!validInstant(input.expiresAt))
        throw new TypeError('export expiresAt must be a valid Date');
      const ms = input.expiresAt.getTime();
      if (ms <= this.#clock.now().getTime()) {
        throw new RangeError('export expiresAt must be later than the current time');
      }
      const url = `${this.#baseUrl}/${input.key}?expires=${ms}&signature=${this.#sign(input.key, ms)}`;
      this.#logger.debug({ event: 'export_store_signed', key: input.key }, 'export link signed');
      // A copy (no `new Date` in app code): later mutation of the input cannot change the result.
      return Promise.resolve({ url, expiresAt: structuredClone(input.expiresAt) });
    } catch (error) {
      return rejectWith(error);
    }
  }

  delete(key: string): Promise<void> {
    try {
      assertKey(key);
      this.#files.delete(key);
      this.#logger.debug({ event: 'export_store_deleted', key }, 'export deleted');
      return Promise.resolve();
    } catch (error) {
      return rejectWith(error);
    }
  }

  get(key: string): { readonly bytes: Uint8Array; readonly contentType: 'text/csv' } | undefined {
    const bytes = this.#files.get(key);
    return bytes === undefined ? undefined : { bytes: bytes.slice(), contentType: CONTENT_TYPE };
  }

  verify(url: string, now: Date): boolean {
    if (typeof url !== 'string' || !validInstant(now)) return false;
    const prefix = `${this.#baseUrl}/`;
    if (!url.startsWith(prefix) || url.includes('#')) return false;
    const rest = url.slice(prefix.length);
    const question = rest.indexOf('?');
    if (question < 0) return false;
    const key = rest.slice(0, question);
    if (!EXPORT_KEY.test(key)) return false;
    const entries = [...new URLSearchParams(rest.slice(question + 1))];
    if (entries.length !== 2) return false;
    const params = new Map(entries);
    const expires = params.get('expires');
    const signature = params.get('signature');
    if (params.size !== 2 || expires === undefined || signature === undefined) return false;
    if (!EXPIRES_MS.test(expires) || !SIGNATURE_HEX.test(signature)) return false;
    const ms = Number(expires);
    if (!Number.isSafeInteger(ms)) return false;
    const expected = Buffer.from(this.#sign(key, ms), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return false;
    return now.getTime() < ms;
  }

  #sign(key: string, ms: number): string {
    return createHmac('sha256', this.#signingKey).update(`${key}\n${ms}`, 'utf8').digest('hex');
  }
}

/**
 * staging / prod before the OSS adapter (B1-30): constructs, then every put and signedUrl fails per
 * request. delete succeeds after the key check: no put ever stored anything here.
 */
class UnavailableExportStore implements ExportStore {
  readonly #logger: RootLogger;

  constructor(logger: RootLogger) {
    this.#logger = logger;
  }

  put(input: ExportPutInput): Promise<void> {
    try {
      checkPut(input);
    } catch (error) {
      return rejectWith(error);
    }
    return this.#refuse('put', input.key);
  }

  signedUrl(input: ExportSignedUrlInput): Promise<ExportSignedUrl> {
    try {
      assertKey(input.key);
    } catch (error) {
      return rejectWith(error);
    }
    return this.#refuse('signedUrl', input.key);
  }

  delete(key: string): Promise<void> {
    try {
      assertKey(key);
      return Promise.resolve();
    } catch (error) {
      return rejectWith(error);
    }
  }

  #refuse<T>(operation: 'put' | 'signedUrl', key: string): Promise<T> {
    this.#logger.warn(
      { event: 'export_store_unavailable', operation, key },
      'export store adapter is not configured; request refused',
    );
    return Promise.reject(new ExportStoreUnavailableError());
  }
}

/** local/test: memory; staging/prod: construction succeeds, requests fail until B1-30. */
export function createExportStore(options: ExportStoreOptions): ExportStore {
  if (options.appEnv === 'local' || options.appEnv === 'test') {
    return new MemoryExportStore({
      baseUrl:
        options.baseUrl === undefined || options.baseUrl === ''
          ? EXPORT_STORE_DEFAULT_LOCAL_BASE_URL
          : options.baseUrl,
      signingKey:
        options.signingKey === undefined || options.signingKey === ''
          ? EXPORT_STORE_DEFAULT_LOCAL_SIGNING_KEY
          : options.signingKey,
      clock: options.clock,
      logger: options.logger,
    });
  }
  return new UnavailableExportStore(options.logger);
}
