import type { AppEnv } from '../config/index.ts';
import type { RootLogger } from '../logging/index.ts';

export interface MediaPutInput {
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly contentType: 'image/svg+xml' | 'image/png';
}

export interface MediaStore {
  put(input: MediaPutInput): Promise<{ url: string }>;
}

// Test-phase placeholder: implementation must replace this declaration with a Symbol token.
// The skeleton gate forbids even a top-level Symbol() initializer in this phase.
export function MEDIA_STORE(): never {
  throw new Error('NotImplemented: MEDIA_STORE');
}

export function mediaUrlOf(
  baseUrl: string | undefined,
  sha256: string,
  format: 'svg' | 'png',
): string {
  void baseUrl;
  void sha256;
  void format;
  throw new Error('NotImplemented: mediaUrlOf');
}

/** Local/test adapter; get returns undefined for an absent digest. */
export class MemoryMediaStore implements MediaStore {
  constructor(baseUrl: string) {
    void baseUrl;
    throw new Error('NotImplemented: MemoryMediaStore');
  }

  put(input: MediaPutInput): Promise<{ url: string }> {
    void input;
    throw new Error('NotImplemented: MemoryMediaStore.put');
  }

  get(sha256: string): Uint8Array | undefined {
    void sha256;
    throw new Error('NotImplemented: MemoryMediaStore.get');
  }
}

/** Ordinary Error: the existing global exception filter maps it to HTTP 500 / code 50001. */
export class MediaStoreUnavailableError extends Error {
  constructor() {
    super('Media store adapter is unavailable');
    throw new Error('NotImplemented: MediaStoreUnavailableError');
  }
}

/** Local/test use memory; staging/prod construct successfully and fail on every put. */
export function createMediaStore(
  appEnv: AppEnv,
  baseUrl: string | undefined,
  logger: RootLogger,
): MediaStore {
  void appEnv;
  void baseUrl;
  void logger;
  throw new Error('NotImplemented: createMediaStore');
}
