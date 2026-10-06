// Stage ① of the rejection order (规划/08 BR-ID-01): the request signature of BR-ID-09, for the
// contract operations marked `x-signed: true` (04 §5 签名), planned ones included. Registered on the
// platform's pre-parsing registration point (platform/http/request-checks.ts), so it answers before
// Fastify parses or validates the body and before the token stages ② ③.
//
// Order inside ① (orchestrator ruling B1-03b §9.5 #4):
//   1. X-Device-Id: missing, not issued by the server or revoked → 10402. The identity module
//      answers through the DeviceSigningKeys port (risk depends on no module, 02 §4.1); every
//      request asks again, so a revocation applies to the next request.
//   2. X-Timestamp 10 digits, X-Nonce 32 lower-case hex, X-Sign 64 lower-case hex, and
//      |server time − X-Timestamp| ≤ 300 s (injected Clock) → else 10401.
//   3. Timing-safe HMAC comparison → else 10401. A wrong signature never reserves a nonce.
//   4. Atomic nonce reservation in Redis (namespace `risk`, key
//      `nonce:<device app_id>:<device_id>:<nonce>`, SET NX with a 600-second TTL in one Lua call);
//      already reserved → 10401. No Redis provider, or Redis failing → the error propagates (the
//      global filter answers 50001): a replay key is never silently skipped (ADR-0001 §4.2 #17).
// The app dimension is the device row's app_id; X-App-Id is not compared here (that is stage ③,
// 10403). On success only the device id and app id are published to the request context.
// Nothing here logs; install_secret, the signing string and X-Sign never leave this function.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`, no NestJS, no decorators.
import {
  RedisUnavailableError,
  RequestRejection,
  isContractSignedRoute,
  type Clock,
  type RedisHandle,
  type RequestCheckInput,
} from '../../platform/index.ts';
import {
  NONCE_TTL_SECONDS,
  expectedSignature,
  isWellFormedNonce,
  isWellFormedSignature,
  isWellFormedTimestamp,
  isWithinSkew,
  signatureMatches,
} from '../domain/request-signature.ts';

/** What stage ① reads of a request: the platform's request check input. */
export type SignatureRequest = RequestCheckInput;

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
  readonly clock: Clock;
  /** Missing/unavailable Redis fails closed after signature verification. */
  readonly redis?: Pick<RedisHandle, 'namespace'>;
}

/** Nest token of the DeviceSigningKeys port (provided by identity, assembled by app.module). */
export const DEVICE_SIGNING_KEYS = Symbol('DEVICE_SIGNING_KEYS');
/** Nest token of the stage ① RequestCheck built by createSignatureCheck (RiskModule). */
export const SIGNATURE_CHECK = Symbol('SIGNATURE_CHECK');

/** Redis namespace of this module (platform/redis prefixes every key with `risk:`). */
const NAMESPACE = 'risk';
/** Reserve a nonce: one SET NX EX with the TTL the Redis handle passes as ARGV[1]. */
const RESERVE_NONCE = "return redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1])";

/** Fallback texts (clients show the dictionary text error.<code>); fixed, never a value. */
const MESSAGES = {
  10401: '请求签名无效或重放',
  10402: '设备未注册、已失效或非服务端签发',
} as const;

/** The global error filter maps these two business failures to HTTP 401/ErrorEnvelope. */
export class SignatureError extends RequestRejection {
  declare readonly code: 10401 | 10402;

  constructor(code: 10401 | 10402) {
    super(code, 401, MESSAGES[code]);
    this.name = 'SignatureError';
  }
}

function headerValue(request: SignatureRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
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
  const { devices, clock } = dependencies;
  if (typeof devices?.findActive !== 'function' || typeof clock?.now !== 'function') {
    throw new TypeError('createSignatureCheck needs the device port and the clock');
  }
  const nonces = dependencies.redis?.namespace(NAMESPACE);
  return async (request) => {
    if (!isContractSignedRoute(request.method, request.routeTemplate)) return;

    const deviceId = headerValue(request, 'x-device-id');
    if (deviceId === undefined || deviceId === '') throw new SignatureError(10402);
    const device = await devices.findActive(deviceId);
    if (device === null) throw new SignatureError(10402);

    const timestamp = headerValue(request, 'x-timestamp');
    const nonce = headerValue(request, 'x-nonce');
    const signature = headerValue(request, 'x-sign');
    if (
      !isWellFormedTimestamp(timestamp) ||
      !isWellFormedNonce(nonce) ||
      !isWellFormedSignature(signature) ||
      !isWithinSkew(timestamp, clock.now().getTime())
    ) {
      throw new SignatureError(10401);
    }
    const expected = expectedSignature(device.installSecret, {
      method: request.method,
      url: request.url,
      timestamp,
      nonce,
      body: request.rawBody,
    });
    if (!signatureMatches(signature, expected)) throw new SignatureError(10401);

    if (nonces === undefined) {
      throw new Error('risk: no Redis in this process; signed requests are refused');
    }
    const reply = await nonces.eval(RESERVE_NONCE, {
      keys: [`nonce:${device.appId}:${device.deviceId}:${nonce}`],
      args: [],
      ttlSeconds: NONCE_TTL_SECONDS,
    });
    if (reply === null) throw new SignatureError(10401);
    if (reply !== 'OK') throw new RedisUnavailableError('unexpected_reply');
    request.verifiedDevice = Object.freeze({ deviceId: device.deviceId, appId: device.appId });
  };
}
