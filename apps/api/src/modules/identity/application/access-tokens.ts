// App session tokens (规划/08 BR-ID-07; 规划/02 §12.1 access_token row) and the token stages of the
// rejection order (BR-ID-01 判定顺序 ② 令牌 10001 / 10002 → ③ App 来源 10403).
//
// access_token: a JWT signed with ES256 (jose; algorithms pinned to ES256, curve P-256), header
// { alg, kid, typ: JWT }, claims uid, app_id, sid, device_id, scp plus iss / aud / iat / exp, valid
// ACCESS_TOKEN_TTL_SECONDS from the injected Clock. Verification looks the header's kid up among the
// local public keys (current + previous, JWT_VERIFY_KEYS_JSON; never a remote key set), checks
// issuer, audience, typ and expiry with a clock tolerance of 0 against the same Clock (expired from
// the second exp names; orchestrator ruling B1-02h §9.5 #6), and every jose failure becomes 10002.
// refresh_token: 32 random bytes (base64url); only its SHA-256 (hex) is stored, expiring
// REFRESH_TOKEN_TTL_MS after issue (rotation and reuse detection are B1-02k).
//
// The signing key comes through a small key port (TokenKeyProvider, ADR-0001 §2 自有 KeyProvider
// 接口): this task reads it from loadConfig's JWT_* variables (platform/config/jwt.ts) and, in
// local / test without them, generates one ephemeral key pair per process; staging / prod without
// them refuse to start. KMS signing (`sign(bytes)` returning DER, converted to R‖S) is a later
// task (§9.5 #3).
//
// createTokenCheck is the RequestCheck app.module places right after the signature check (①) at
// the platform's pre-parsing registration point, so it answers before any body is read or
// validated (20001) and before idempotency (1xxxx are never recorded, BR-ID-10 细则). Per matched
// route, by the contract's x-auth (platform auth-routes, planned operations included):
//   - outside the contract: nothing is read, nothing is checked (no Authorization, no ③);
//   - none: Authorization is never read (a refresh with an expired access token is not 10002);
//   - optional: no Authorization → anonymous; with one it must be valid (10002);
//   - login / phone / realname: no Authorization → 10001; malformed (not `Bearer <token>`, empty,
//     repeated: the registration point hands every value of a repeated header as an array, also
//     over real HTTP where Node keeps only the first), bad signature, unknown kid, wrong issuer /
//     audience, expired, claims missing, or
//     a session that does not exist or is revoked → 10002. The session (sessions, by app_id and
//     sid) is read on every request, so a revocation applies to the next one (§9.3 #2).
//   - admin / super (admin console levels, admin_auth_level; an admin_token, never an app token):
//     fail closed with 10001 whether or not Authorization is sent; nothing is read (no header, no
//     session, no ③). No app token can satisfy them and the admin token check does not exist yet.
//   ③ with a token: X-App-Id must equal the token's app_id; without one, on a contract x-signed
//   route: X-App-Id must equal the app_id of the device stage ① verified. Missing, repeated or
//   different → 10403 (§9.5 #8). Unsigned anonymous requests have no ③ here (§9.5 #2).
// On success the verified claims are attached as the request's principal (platform
// token-context); nothing in it comes from a header. The session scope is not enforced here:
// deletion_only passes ② ③ and the 10405 of x-session-scopes is stage ④a (B1-03c).
// Nothing here logs; tokens and keys never leave these functions except as the issued strings.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no decorators.
import {
  createHash,
  createPublicKey,
  generateKeyPair,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { errorCodes, SessionScope } from '@couli/contracts-ts';
import { SignJWT, errors, jwtVerify, type JWTPayload } from 'jose';
import {
  RequestRejection,
  contractAuthOf,
  isContractSignedRoute,
  isJwtKeyId,
  parseP256PrivateKeyPem,
  parseP256PublicKeyPem,
  type AppEnv,
  type Clock,
  type JwtKeyConfig,
  type RequestCheck,
  type RequestCheckInput,
  type TokenPrincipal,
} from '../../platform/index.ts';

/** BR-ID-07: an access token is valid for 2 hours. */
export const ACCESS_TOKEN_TTL_SECONDS = 2 * 60 * 60;
/** BR-ID-07: a refresh token is valid for 30 days from its issue (rotation restarts it, B1-02k). */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Orchestrator ruling B1-02h §9.3 #9: 32 random bytes. */
const REFRESH_TOKEN_BYTES = 32;
/** Who issues App access tokens (the api entry; admin tokens get their own key and issuer). */
const ISSUER = 'couli-api';
/** App tokens; the read-only h5_token of BR-ID-32 (aud=h5) is a different audience (B1-02f). */
const AUDIENCE = 'app';
const SCOPES: ReadonlySet<unknown> = new Set<SessionScope>(['full', 'deletion_only']);
/** Upper bound of a claim's length: the ids are UUIDs, app_id is short, sid is opaque. */
const MAX_CLAIM_LENGTH = 128;

type TokenCode = 10001 | 10002 | 10403;

/**
 * HTTP status (contracts/error-codes.yaml `http`; `satisfies` fails the build when the generated
 * catalogue disagrees) and fallback text (`msg`; clients show their dictionary text error.<code>)
 * of the token stages: the first clause of the contract `meaning`. Fixed texts, never a value.
 */
export const TOKEN_REJECTIONS = Object.freeze({
  10001: Object.freeze({ http: 401, msg: '未登录' }),
  10002: Object.freeze({ http: 401, msg: 'access_token 过期' }),
  10403: Object.freeze({ http: 403, msg: 'App 或请求来源不被允许（含令牌作用域越权）' }),
} as const) satisfies {
  readonly [C in TokenCode]: Pick<(typeof errorCodes)[C], 'http'> & { readonly msg: string };
};

/** The global error filter answers these with their status and { code, msg, trace_id }, no data. */
export class TokenRejection extends RequestRejection {
  declare readonly code: TokenCode;

  constructor(code: TokenCode) {
    super(code, TOKEN_REJECTIONS[code].http, TOKEN_REJECTIONS[code].msg);
    this.name = 'TokenRejection';
  }
}

/** Local signing port; KMS sign(bytes) is deferred per B1-02h §9.5. */
export interface TokenKeyProvider {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKeys: ReadonlyMap<string, KeyObject>;
}

export interface TokenService {
  issueAccess(principal: TokenPrincipal): Promise<string>;
  /** jose ES256 only, local kid lookup, issuer/audience checked, Clock, zero tolerance; 10002. */
  verifyAccess(token: string): Promise<TokenPrincipal>;
  issueRefresh(): { token: string; hash: string; expireAt: Date };
}

const generateEcKeyPair = promisify(generateKeyPair);

function isP256PrivateKey(key: unknown): key is KeyObject {
  const candidate = key as Partial<KeyObject> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    candidate.type === 'private' &&
    candidate.asymmetricKeyType === 'ec' &&
    candidate.asymmetricKeyDetails?.namedCurve === 'prime256v1'
  );
}

/** Missing JWT configuration is allowed only in local/test; staging/prod reject at startup. */
export async function createTokenKeyProvider(
  appEnv: AppEnv,
  config: JwtKeyConfig | null,
): Promise<TokenKeyProvider> {
  if (config === null) {
    if (appEnv !== 'local' && appEnv !== 'test') {
      throw new Error(
        `JWT_PRIVATE_KEY_PEM and JWT_KEY_ID must be set when APP_ENV=${appEnv}: access tokens are signed with a configured key outside local and test`,
      );
    }
    // One key pair per process: tokens of an earlier run fail with 10002 after a restart.
    const pair = await generateEcKeyPair('ec', { namedCurve: 'prime256v1' });
    const kid = `ephemeral-${randomBytes(8).toString('hex')}`;
    return Object.freeze({
      kid,
      privateKey: pair.privateKey,
      publicKeys: new Map([[kid, pair.publicKey]]),
    });
  }
  // loadConfig validated these already; a hand-built configuration is checked again here.
  const privateKey = parseP256PrivateKeyPem(config.privateKeyPem);
  if (privateKey === null || !isJwtKeyId(config.kid)) {
    throw new Error(
      'JWT_PRIVATE_KEY_PEM / JWT_KEY_ID: a P-256 PKCS#8 private key and a well-formed key id are required',
    );
  }
  const publicKeys = new Map<string, KeyObject>([[config.kid, createPublicKey(privateKey)]]);
  for (const [kid, pem] of Object.entries(config.verificationKeys)) {
    const key = parseP256PublicKeyPem(pem);
    if (kid === config.kid || !isJwtKeyId(kid) || key === null) {
      throw new Error(
        'JWT_VERIFY_KEYS_JSON: every previous key needs its own well-formed key id and a P-256 SPKI public key',
      );
    }
    publicKeys.set(kid, key);
  }
  return Object.freeze({ kid: config.kid, privateKey, publicKeys });
}

function isClaim(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CLAIM_LENGTH;
}

/** The five claims of a verified payload, or null when one is missing or malformed. */
function principalOf(payload: JWTPayload): TokenPrincipal | null {
  const { uid, app_id: appId, sid, device_id: deviceId, scp } = payload;
  if (!isClaim(uid) || !isClaim(appId) || !isClaim(sid) || !isClaim(deviceId)) return null;
  if (!SCOPES.has(scp)) return null;
  return Object.freeze({
    uid,
    app_id: appId,
    sid,
    device_id: deviceId,
    scp: scp as SessionScope,
  });
}

/** `instant` plus `ms` as a new Date (the Clock's instant is never modified). */
function later(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + ms);
  return result;
}

export function createTokenService(deps: { clock: Clock; keys: TokenKeyProvider }): TokenService {
  const { clock, keys } = deps;
  if (typeof clock?.now !== 'function') throw new TypeError('createTokenService needs the clock');
  if (
    typeof keys?.kid !== 'string' ||
    !isJwtKeyId(keys.kid) ||
    !isP256PrivateKey(keys.privateKey) ||
    !(keys.publicKeys instanceof Map)
  ) {
    throw new TypeError('createTokenService needs a key id, a P-256 private key and public keys');
  }
  // A token signed under a kid missing from the verification keys would fail its own check.
  if (!keys.publicKeys.has(keys.kid)) {
    throw new TypeError(
      'createTokenService needs the public key of the signing key id among the verification keys',
    );
  }
  const { kid, privateKey } = keys;
  // A snapshot: changing the provider's map later cannot add a verification key.
  const publicKeys: ReadonlyMap<string, KeyObject> = new Map(keys.publicKeys);
  const resolveKey = (header: { kid?: unknown }): KeyObject => {
    const key = typeof header.kid === 'string' ? publicKeys.get(header.kid) : undefined;
    if (key === undefined) throw new errors.JWKSNoMatchingKey();
    return key;
  };
  return {
    async issueAccess(principal) {
      const claims = principalOf({ ...principal });
      if (claims === null)
        throw new TypeError('issueAccess needs uid, app_id, sid, device_id, scp');
      const issuedAt = Math.floor(clock.now().getTime() / 1000);
      return new SignJWT({ ...claims })
        .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
        .sign(privateKey);
    },
    async verifyAccess(token) {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, resolveKey, {
          algorithms: ['ES256'],
          issuer: ISSUER,
          audience: AUDIENCE,
          typ: 'JWT',
          requiredClaims: ['iat', 'exp'],
          maxTokenAge: ACCESS_TOKEN_TTL_SECONDS,
          clockTolerance: 0,
          currentDate: clock.now(),
        }));
      } catch (error) {
        // Every jose refusal (format, algorithm, key, signature, claims, expiry) is one answer.
        if (error instanceof errors.JOSEError) throw new TokenRejection(10002);
        throw error;
      }
      const principal = principalOf(payload);
      if (principal === null) throw new TokenRejection(10002);
      return principal;
    },
    issueRefresh() {
      const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
      return {
        token,
        hash: createHash('sha256').update(token).digest('hex'),
        expireAt: later(clock.now(), REFRESH_TOKEN_TTL_MS),
      };
    },
  };
}

export interface SessionLookup {
  /** Each authenticated request reads its current session, scoped by app_id. */
  find(
    appId: string,
    sid: string,
  ): Promise<{
    revoked_at: Date | null;
  } | null>;
}

/** `Bearer <token>` (RFC 6750 §2.1; the scheme is case-insensitive, RFC 9110 §11.1). */
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

function headerValue(request: RequestCheckInput, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** The checks createTokenCheck built: bootstrap asks whether an entry's plan contains one. */
const TOKEN_CHECKS = new WeakSet<RequestCheck>();

/**
 * True for a stage ② ③ check built by createTokenCheck (bootstrap's route guard: an entry whose
 * plan has none refuses a contract route that needs a token; the same way as risk's
 * isSignatureCheck for stage ①).
 */
export function isTokenCheck(check: unknown): boolean {
  return typeof check === 'function' && TOKEN_CHECKS.has(check as RequestCheck);
}

/** Stages ② and ③ after signature, before body validation, using the full contract auth table. */
export function createTokenCheck(deps: {
  tokens: TokenService;
  sessions: SessionLookup;
}): RequestCheck {
  const { tokens, sessions } = deps;
  if (typeof tokens?.verifyAccess !== 'function' || typeof sessions?.find !== 'function') {
    throw new TypeError('createTokenCheck needs the token service and the session lookup');
  }

  /** Stage ②: the verified claims of a live session, or 10002. */
  const authenticate = async (authorization: string | string[]): Promise<TokenPrincipal> => {
    const token = typeof authorization === 'string' ? BEARER.exec(authorization)?.[1] : undefined;
    if (token === undefined) throw new TokenRejection(10002);
    const principal = await tokens.verifyAccess(token);
    const session = await sessions.find(principal.app_id, principal.sid);
    if (session === null || session.revoked_at !== null) throw new TokenRejection(10002);
    return principal;
  };

  const check: RequestCheck = async (request) => {
    const template = request.routeTemplate;
    const auth = template === undefined ? undefined : contractAuthOf(request.method, template);
    // Outside the contract: no Authorization is read and no stage applies.
    if (auth === undefined) return;
    // Admin levels: an app token never satisfies them and there is no admin token check yet, so
    // fail closed before reading Authorization or any session (bootstrap also refuses the routes).
    if (auth === 'admin' || auth === 'super') throw new TokenRejection(10001);
    if (auth !== 'none') {
      const authorization = request.headers['authorization'];
      if (authorization !== undefined) {
        const principal = await authenticate(authorization);
        // ③ after login, app_id comes from the token only (BR-ID-07).
        if (headerValue(request, 'x-app-id') !== principal.app_id) throw new TokenRejection(10403);
        request.principal = principal;
        return;
      }
      if (auth !== 'optional') throw new TokenRejection(10001);
    }
    // ③ before login: a signed request's X-App-Id must be its verified device's app (BR-ID-07).
    if (isContractSignedRoute(request.method, template)) {
      const device = request.verifiedDevice;
      if (device === undefined || headerValue(request, 'x-app-id') !== device.appId) {
        throw new TokenRejection(10403);
      }
    }
  };
  TOKEN_CHECKS.add(check);
  return check;
}
