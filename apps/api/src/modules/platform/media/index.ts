// Media store port (F1-06z; 08 BR-TEXT-24 细则: OSS `media` bucket, file named by the content
// SHA-256, long cache; the same digest travels in the payload). Files are content-addressed:
// `<MEDIA_PUBLIC_BASE_URL>/<sha256>.<svg|png>`, so readers derive the URL with mediaUrlOf without
// touching the store, and writing the same digest twice is a no-op returning the same URL.
// local / test: in-process memory stand-in. staging / prod: until the OSS adapter lands (B1-30),
// construction succeeds and every put fails per request (MediaStoreUnavailableError, a plain Error
// the global filter maps to HTTP 500 / 50001), like the SMS sender default. Logs carry the digest
// only, never the content.
// Erasable syntax only (also compiled by the `test` project).
import { createHash } from 'node:crypto';
import type { AppEnv } from '../config/index.ts';
import { MEDIA_DEFAULT_LOCAL_BASE_URL } from '../config/media.ts';
import type { RootLogger } from '../logging/index.ts';

export type MediaContentType = 'image/svg+xml' | 'image/png';
export type MediaFormat = 'svg' | 'png';

export interface MediaPutInput {
  /** Lower-case hex SHA-256 of `bytes` (64 characters). */
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly contentType: MediaContentType;
}

export interface MediaStore {
  /** Stores the content under its digest (idempotent) and returns its public https URL. */
  put(input: MediaPutInput): Promise<{ url: string }>;
}

/** Nest injection token of the process-wide MediaStore (provided globally by PlatformModule). */
export const MEDIA_STORE = Symbol('MEDIA_STORE');

const SHA256_HEX = /^[0-9a-f]{64}$/;

const FORMAT_OF: Readonly<Record<MediaContentType, MediaFormat>> = Object.freeze({
  'image/svg+xml': 'svg',
  'image/png': 'png',
});

/**
 * The media store has no usable backend in this environment (staging / prod without the OSS
 * adapter or without MEDIA_PUBLIC_BASE_URL). Deliberately a plain Error without a business code:
 * the global exception filter answers HTTP 500 / 50001.
 */
export class MediaStoreUnavailableError extends Error {
  constructor() {
    super('Media store adapter is unavailable');
    this.name = 'MediaStoreUnavailableError';
  }
}

function assertDigestFormat(sha256: string): void {
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    throw new TypeError('media sha256 must be 64 lower-case hexadecimal characters');
  }
}

function formatOf(contentType: MediaContentType): MediaFormat {
  if (!Object.hasOwn(FORMAT_OF, contentType)) {
    throw new TypeError('media contentType must be image/svg+xml or image/png');
  }
  return FORMAT_OF[contentType];
}

/** Programming-error checks shared by every adapter: digest format, content type, digest match. */
function checkInput(input: MediaPutInput): MediaFormat {
  assertDigestFormat(input.sha256);
  const format = formatOf(input.contentType);
  if (!(input.bytes instanceof Uint8Array)) throw new TypeError('media bytes must be a Uint8Array');
  // Hashes the view's own bytes only (byteOffset / byteLength), never the whole backing buffer.
  const actual = createHash('sha256').update(input.bytes).digest('hex');
  if (actual !== input.sha256) throw new Error('media sha256 does not match the content');
  return format;
}

/**
 * `<baseUrl without trailing slashes>/<sha256>.<format>`; usable by readers without a put. An
 * undefined or empty base (staging / prod without MEDIA_PUBLIC_BASE_URL) throws
 * MediaStoreUnavailableError (per-request 50001); a malformed digest or format is a programming
 * error.
 */
export function mediaUrlOf(
  baseUrl: string | undefined,
  sha256: string,
  format: MediaFormat,
): string {
  assertDigestFormat(sha256);
  if (format !== 'svg' && format !== 'png') throw new TypeError('media format must be svg or png');
  const base = (baseUrl ?? '').replace(/\/+$/, '');
  if (base === '') throw new MediaStoreUnavailableError();
  return `${base}/${sha256}.${format}`;
}

/** Local/test adapter; get returns undefined for an absent digest. */
export class MemoryMediaStore implements MediaStore {
  readonly #baseUrl: string;
  readonly #files = new Map<string, Uint8Array>();

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl;
  }

  put(input: MediaPutInput): Promise<{ url: string }> {
    try {
      const format = checkInput(input);
      const url = mediaUrlOf(this.#baseUrl, input.sha256, format);
      // Content-addressed: an existing digest already holds these exact bytes; never overwrite.
      if (!this.#files.has(input.sha256)) this.#files.set(input.sha256, input.bytes.slice());
      return Promise.resolve({ url });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Test read-back: a copy of the stored bytes, or undefined. */
  get(sha256: string): Uint8Array | undefined {
    return this.#files.get(sha256)?.slice();
  }
}

/** staging / prod before the OSS adapter (B1-30): constructs, then every put fails per request. */
class UnavailableMediaStore implements MediaStore {
  readonly #logger: RootLogger;

  constructor(logger: RootLogger) {
    this.#logger = logger;
  }

  put(input: MediaPutInput): Promise<{ url: string }> {
    try {
      checkInput(input);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.#logger.warn(
      { event: 'media_store_unavailable', sha256: input.sha256 },
      'media store adapter is not configured; put refused',
    );
    return Promise.reject(new MediaStoreUnavailableError());
  }
}

/** Local/test use memory; staging/prod construct successfully and fail on every put. */
export function createMediaStore(
  appEnv: AppEnv,
  baseUrl: string | undefined,
  logger: RootLogger,
): MediaStore {
  if (appEnv === 'local' || appEnv === 'test') {
    return new MemoryMediaStore(
      baseUrl === undefined || baseUrl === '' ? MEDIA_DEFAULT_LOCAL_BASE_URL : baseUrl,
    );
  }
  return new UnavailableMediaStore(logger);
}
