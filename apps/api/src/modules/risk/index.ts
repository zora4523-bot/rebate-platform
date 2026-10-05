// Also compiled by the test project: erasable syntax only, import type for type-only
// imports, relative imports with .ts; no NestJS imports or decorators.
/** Structural ports keep this public surface independent of Nest and other modules. */
export interface SignatureRequest {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly routeTemplate?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly rawBody: Buffer;
  verifiedDevice?: { readonly deviceId: string; readonly appId: string };
}

/** Identity implements this port; risk must not import identity or read its tables. */
export interface DeviceSigningKey {
  readonly deviceId: string;
  readonly appId: string;
  readonly installSecret: string;
}

export interface DeviceSigningKeys {
  /** Look up the globally unique id, never X-App-Id. Missing/revoked => null. */
  findActive(deviceId: string): Promise<DeviceSigningKey | null>;
}

export interface SignatureDependencies {
  readonly devices: DeviceSigningKeys;
  readonly clock: { now(): Date };
  /** Missing/unavailable Redis fails closed after signature verification. */
  readonly redis?: {
    namespace(name: string): {
      eval(
        script: string,
        options: {
          readonly keys: readonly string[];
          readonly args: readonly string[];
          readonly ttlSeconds: number;
        },
      ): Promise<unknown>;
    };
  };
}

/** The global error filter maps these two business failures to HTTP 401/ErrorEnvelope. */
export class SignatureError extends Error {
  readonly code!: 10401 | 10402;

  constructor(code: 10401 | 10402) {
    super('Request signature rejected');
    void code;
    throw new Error('NotImplemented: SignatureError');
  }
}

/**
 * Only contract x-signed:true routes (including planned operations) enter stage ①.
 * Device => timestamp/nonce format and skew => timing-safe HMAC => atomic nonce reservation.
 * The key is risk:nonce:<device app_id>:<device_id>:<nonce>, with a 600-second TTL.
 * Lua returns SET ... NX EX ARGV[1] unchanged: 'OK' on reservation, nil on replay.
 * Bad HMAC never reserves a nonce. On success publish only deviceId/appId to the context.
 */
export function createSignatureCheck(
  dependencies: SignatureDependencies,
): (request: SignatureRequest) => Promise<void> {
  void dependencies;
  throw new Error('NotImplemented: createSignatureCheck');
}
