// B1-02zj (D10-255 ①) verification equivalence of a verify-only process (identity's
// access-tokens.ts): a token the signing process issues with its private key verifies on a
// verifier configured with the public key only (readJwtVerifyKeyConfig →
// createTokenVerifyKeyProvider → createTokenVerifyService); an unknown kid, another key, a changed
// signature or payload is
// 10002 as before; previous kids of JWT_VERIFY_KEYS_JSON verify too; the verifier never signs and
// holds no private key; staging / prod without keys refuse, naming JWT_PUBLIC_KEY_PEM.
// Time and claims are judged as the signing process's own verifier (createTokenService) judges
// them, on the same moving Clock: expired from the second exp names, iat and exp required, an
// access token older than its 2-hour lifetime or issued in the future refused, issuer / audience /
// typ checked; every refusal is 10002.
// Keys are generated in the test (node:crypto); no .env file is read.
import { generateKeyPairSync, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  H5_AUDIENCE,
  TokenRejection,
  createTokenKeyProvider,
  createTokenService,
  createTokenVerifyKeyProvider,
  createTokenVerifyService,
  signScopedToken,
  type TokenService,
  type TokenVerifyKeyProvider,
} from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { readJwtVerifyKeyConfig } from '../../../../apps/api/src/modules/platform/config/jwt.ts';
import {
  CLOUD_ENVS,
  INSTANT,
  ISSUED_AT,
  KID,
  OTHER_KID,
  PREVIOUS_KID,
  PRINCIPAL,
  accessToken,
  clock,
  describeError,
  p256,
  privateKeysIn,
  settle,
  signer,
  tamperPayload,
  tamperSignature,
  type CloudEnv,
  type PemPair,
  type Settled,
} from './kit.ts';

/** JWT_KEY_ID + JWT_PUBLIC_KEY_PEM: what a stream process is given from now on. */
function publicEnv(pair: PemPair): Record<string, string> {
  return { JWT_KEY_ID: KID, JWT_PUBLIC_KEY_PEM: pair.publicPem };
}

/** JWT_KEY_ID + JWT_PRIVATE_KEY_PEM: what an existing deployment gives every process. */
function privateEnv(pair: PemPair): Record<string, string> {
  return { JWT_KEY_ID: KID, JWT_PRIVATE_KEY_PEM: pair.privatePem };
}

/** The verify-only side as a stream process builds it from its environment. */
async function verifier(
  appEnv: CloudEnv,
  env: Readonly<Record<string, string>>,
  at: FixedClock = clock(),
): Promise<{ readonly keys: TokenVerifyKeyProvider; readonly tokens: TokenService }> {
  const read = readJwtVerifyKeyConfig(appEnv, env);
  expect(read.problems).toEqual([]);
  const keys = await createTokenVerifyKeyProvider(appEnv, read.jwt);
  return { keys, tokens: createTokenVerifyService({ clock: at, keys }) };
}

/** The lifetime of the h5_token signed below (the issuer passes its own, B1-02f). */
const H5_TTL_SECONDS = 600;

type Claims = Readonly<Record<string, unknown>>;

/** The header and the claims of a compact token (read, not verified). */
function partsOf(token: string): { readonly header: Claims; readonly claims: Claims } {
  const [header, payload] = token.split('.');
  const read = (part: string | undefined): Claims =>
    JSON.parse(Buffer.from(part ?? '', 'base64url').toString()) as Claims;
  return { header: read(header), claims: read(payload) };
}

/** A compact ES256 token over `header` and `claims`, signed with the private key of `pair`. */
function signedWith(pair: PemPair, header: Claims, claims: Claims): string {
  const encode = (value: Claims): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode(header)}.${encode(claims)}`;
  const signature = sign('sha256', Buffer.from(input), {
    key: pair.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${signature.toString('base64url')}`;
}

/** `claims` without the claim `name`. */
function without(claims: Claims, name: string): Claims {
  return Object.fromEntries(Object.entries(claims).filter(([key]) => key !== name));
}

interface TimedCase {
  /** Which verification of the token service judges the token. */
  readonly as: 'access' | 'h5';
  readonly token: string;
  /** Seconds the Clock stands after the issue instant (negative: before it). */
  readonly after: number;
}

function verifyAs(tokens: TokenService, as: TimedCase['as'], token: string): Promise<unknown> {
  if (as === 'access') return tokens.verifyAccess(token);
  if (tokens.verifyH5 === undefined) return Promise.reject(new Error('verifyH5 is missing'));
  return tokens.verifyH5(token);
}

/** The verdict of every case, the Clock set to the case's instant first. */
async function judged(
  tokens: TokenService,
  at: FixedClock,
  cases: Readonly<Record<string, TimedCase>>,
): Promise<Record<string, unknown>> {
  const seen: Record<string, unknown> = {};
  for (const [label, item] of Object.entries(cases)) {
    at.set(INSTANT);
    at.advanceMs(item.after * 1000);
    seen[label] = verdict(await settle(() => verifyAs(tokens, item.as, item.token)));
  }
  return seen;
}

/** The token answer of a verification: accepted, the rejection code, or another error. */
function verdict(outcome: Settled<unknown>): unknown {
  if (!('error' in outcome)) return 'accepted';
  if (outcome.error instanceof TokenRejection) return outcome.error.code;
  return describeError(outcome.error);
}

/** What an error says, or `started` when there was none. */
function failure(outcome: Settled<unknown>): string {
  return 'error' in outcome ? describeError(outcome.error) : 'started';
}

for (const appEnv of CLOUD_ENVS) {
  it(`[D10-255][BR-ID-07] ${appEnv}：私钥签发的 access_token 与 h5_token，只配 JWT_PUBLIC_KEY_PEM 的验签器验过，声明不变`, async () => {
    const pair = p256();
    const signing = await signer(KID, pair);
    const access = await signing.tokens.issueAccess(PRINCIPAL);
    const h5Claims = {
      uid: PRINCIPAL.uid,
      app_id: PRINCIPAL.app_id,
      sid: PRINCIPAL.sid,
      device_id: PRINCIPAL.device_id,
      scp: 'standard',
    };
    const h5 = await signScopedToken(signing.keys, {
      audience: H5_AUDIENCE,
      claims: h5Claims,
      issuedAt: ISSUED_AT,
      ttlSeconds: 600,
    });

    const verify = await verifier(appEnv, publicEnv(pair));
    expect(await verify.tokens.verifyAccess(access)).toEqual(PRINCIPAL);
    expect(typeof verify.tokens.verifyH5).toBe('function');
    expect(await verify.tokens.verifyH5?.(h5)).toEqual(h5Claims);
  });

  it(`[D10-255][BR-ID-07] ${appEnv}：只给私钥（现有部署）时由私钥导出的公钥同样验过`, async () => {
    const pair = p256();
    const access = await accessToken(KID, pair);
    const verify = await verifier(appEnv, privateEnv(pair));
    expect(await verify.tokens.verifyAccess(access)).toEqual(PRINCIPAL);
  });

  it(`[D10-255][BR-ID-01][BR-ID-07] ${appEnv}：kid 不符、换了密钥、签名或载荷被改的令牌在只验签进程回 10002`, async () => {
    const pair = p256();
    const verify = await verifier(appEnv, publicEnv(pair));
    const genuine = await accessToken(KID, pair);
    const refused = {
      // Same key, a kid the verifier does not know.
      'unknown kid': await accessToken(OTHER_KID, pair),
      // The verifier's kid, signed by another private key.
      'other key': await accessToken(KID, p256()),
      'signature changed': tamperSignature(genuine),
      'payload changed': tamperPayload(genuine),
    };
    const seen: Record<string, unknown> = {};
    for (const [label, token] of Object.entries(refused)) {
      seen[label] = verdict(await settle(() => verify.tokens.verifyAccess(token)));
    }
    expect(seen).toEqual({
      'unknown kid': 10002,
      'other key': 10002,
      'signature changed': 10002,
      'payload changed': 10002,
    });
    // The genuine token still verifies on the same verifier.
    expect(await verify.tokens.verifyAccess(genuine)).toEqual(PRINCIPAL);
  });

  it(`[D10-255][BR-ID-01][BR-ID-07] ${appEnv}：Clock 推到 exp 及之后、缺 iat / exp、iat 超过 2 小时或在未来、iss / aud / typ 不符的令牌，只验签进程与签发方验签器同口径回 10002`, async () => {
    const pair = p256();
    const signing = await signer(KID, pair);
    const access = await signing.tokens.issueAccess(PRINCIPAL);
    const h5 = await signScopedToken(signing.keys, {
      audience: H5_AUDIENCE,
      claims: {
        uid: PRINCIPAL.uid,
        app_id: PRINCIPAL.app_id,
        sid: PRINCIPAL.sid,
        device_id: PRINCIPAL.device_id,
        scp: 'standard',
      },
      issuedAt: ISSUED_AT,
      ttlSeconds: H5_TTL_SECONDS,
    });
    // Same key, kid, header and claims as the issued tokens, one thing changed per case.
    const issued = partsOf(access);
    const issuedH5 = partsOf(h5);
    const changed = (changes: Claims): string =>
      signedWith(pair, issued.header, { ...issued.claims, ...changes });
    const ttl = ACCESS_TOKEN_TTL_SECONDS;
    const cases: Record<string, TimedCase> = {
      'access at issue': { as: 'access', token: access, after: 0 },
      'access 1 s before exp': { as: 'access', token: access, after: ttl - 1 },
      'access at exp': { as: 'access', token: access, after: ttl },
      'access 1 h after exp': { as: 'access', token: access, after: ttl + 3600 },
      'access, Clock 60 s before iat': { as: 'access', token: access, after: -60 },
      'access without exp': {
        as: 'access',
        token: signedWith(pair, issued.header, without(issued.claims, 'exp')),
        after: 0,
      },
      'access without iat': {
        as: 'access',
        token: signedWith(pair, issued.header, without(issued.claims, 'iat')),
        after: 0,
      },
      'access iat older than 2 h, exp still ahead': {
        as: 'access',
        token: changed({ iat: ISSUED_AT - ttl - 1, exp: ISSUED_AT + 3600 }),
        after: 0,
      },
      'access with a 30-day exp, 2 h 1 s after iat': {
        as: 'access',
        token: changed({ exp: ISSUED_AT + 30 * 24 * 3600 }),
        after: ttl + 1,
      },
      'access of another issuer': {
        as: 'access',
        token: changed({ iss: 'b1-02zj-other' }),
        after: 0,
      },
      'access of the h5 audience': {
        as: 'access',
        token: changed({ aud: H5_AUDIENCE }),
        after: 0,
      },
      'access with another typ': {
        as: 'access',
        token: signedWith(pair, { ...issued.header, typ: 'at+jwt' }, issued.claims),
        after: 0,
      },
      'h5 1 s before exp': { as: 'h5', token: h5, after: H5_TTL_SECONDS - 1 },
      'h5 at exp': { as: 'h5', token: h5, after: H5_TTL_SECONDS },
      'h5 without exp': {
        as: 'h5',
        token: signedWith(pair, issuedH5.header, without(issuedH5.claims, 'exp')),
        after: 0,
      },
      'h5 without iat': {
        as: 'h5',
        token: signedWith(pair, issuedH5.header, without(issuedH5.claims, 'iat')),
        after: 0,
      },
    };
    const expected = {
      'access at issue': 'accepted',
      'access 1 s before exp': 'accepted',
      'access at exp': 10002,
      'access 1 h after exp': 10002,
      'access, Clock 60 s before iat': 10002,
      'access without exp': 10002,
      'access without iat': 10002,
      'access iat older than 2 h, exp still ahead': 10002,
      'access with a 30-day exp, 2 h 1 s after iat': 10002,
      'access of another issuer': 10002,
      'access of the h5 audience': 10002,
      'access with another typ': 10002,
      'h5 1 s before exp': 'accepted',
      'h5 at exp': 10002,
      'h5 without exp': 10002,
      'h5 without iat': 10002,
    };

    // The signing process's verifier (B1-02h) on a moving Clock answers this table ...
    const at = clock();
    const reference = createTokenService({ clock: at, keys: signing.keys });
    expect(await judged(reference, at, cases)).toEqual(expected);
    // ... and the verify-only process answers exactly the same, on the same Clock.
    const verify = await verifier(appEnv, publicEnv(pair), at);
    expect(await judged(verify.tokens, at, cases)).toEqual(expected);
  });

  it(`[D10-255][BR-ID-07] ${appEnv}：JWT_VERIFY_KEYS_JSON 中旧 kid 签的令牌在只验签进程同样验过；不配旧 kid 则 10002`, async () => {
    const current = p256();
    const previous = p256();
    const old = await accessToken(PREVIOUS_KID, previous);
    const withPrevious = await verifier(appEnv, {
      ...publicEnv(current),
      JWT_VERIFY_KEYS_JSON: JSON.stringify({ [PREVIOUS_KID]: previous.publicPem }),
    });
    const kids = [...withPrevious.keys.publicKeys.keys()].sort();
    expect(kids).toEqual([KID, PREVIOUS_KID].sort());
    expect(await withPrevious.tokens.verifyAccess(old)).toEqual(PRINCIPAL);

    const withoutPrevious = await verifier(appEnv, publicEnv(current));
    const outcome = await settle(() => withoutPrevious.tokens.verifyAccess(old));
    expect(verdict(outcome)).toBe(10002);
  });

  it(`[D10-255][BR-ID-07] ${appEnv}：只验签进程不持有私钥、不能签发（签发失败，不悄悄换密钥）`, async () => {
    const pair = p256();
    // Given the private key (existing deployments), it still only derives the public key.
    for (const env of [publicEnv(pair), privateEnv(pair)]) {
      const verify = await verifier(appEnv, env);
      expect(verify.keys.kid).toBe(KID);
      expect([...verify.keys.publicKeys.keys()]).toEqual([KID]);
      expect(verify.keys.publicKeys.get(KID)?.equals(pair.publicKey)).toBe(true);
      expect(privateKeysIn(verify.keys)).toBe(0);
      const issued = await settle(() => verify.tokens.issueAccess(PRINCIPAL));
      expect('error' in issued ? 'refused' : 'issued a token').toBe('refused');
    }
  });

  it(`[D10-255][BR-ID-07] ${appEnv}：没有验签配置时只验签密钥端口拒绝启动并点名 JWT_PUBLIC_KEY_PEM；签发端口仍点名 JWT_PRIVATE_KEY_PEM`, async () => {
    const verifyOnly = await settle(() => createTokenVerifyKeyProvider(appEnv, null));
    expect(failure(verifyOnly)).toMatch(/JWT_PUBLIC_KEY_PEM/);
    const signing = await settle(() => createTokenKeyProvider(appEnv, null));
    expect(failure(signing)).toMatch(/JWT_PRIVATE_KEY_PEM/);
  });

  it(`[D10-255][BR-ID-07] ${appEnv}：手工构造的验签配置照样复核（非 P-256 公钥、坏 kid、旧 kid 与当前 kid 相同都拒绝）`, async () => {
    const pair = p256();
    // The well-formed configuration starts (so the refusals below are about the values).
    const wellFormed = { kid: KID, publicKeyPem: pair.publicPem, verificationKeys: {} };
    const good = await settle(() => createTokenVerifyKeyProvider(appEnv, wellFormed));
    expect(failure(good)).toBe('started');

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    const cases = {
      'rsa public key': {
        ...wellFormed,
        publicKeyPem: rsa.export({ type: 'spki', format: 'pem' }).toString(),
      },
      'malformed kid': { ...wellFormed, kid: 'bad kid/with space' },
      'previous equals current': { ...wellFormed, verificationKeys: { [KID]: pair.publicPem } },
    };
    const seen: Record<string, string> = {};
    for (const [label, config] of Object.entries(cases)) {
      const outcome = await settle(() => createTokenVerifyKeyProvider(appEnv, config));
      seen[label] = 'error' in outcome ? 'refused' : 'started';
    }
    expect(seen).toEqual({
      'rsa public key': 'refused',
      'malformed kid': 'refused',
      'previous equals current': 'refused',
    });
  });
}
