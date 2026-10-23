// B1-02zj (D10-255 ①) verification equivalence of a verify-only process (identity's
// access-tokens.ts): a token the signing process issues with its private key verifies on a
// verifier configured with the public key only (readJwtVerifyKeyConfig →
// createTokenVerifyKeyProvider → createTokenVerifyService); an unknown kid, another key, a changed
// signature or payload is
// 10002 as before; previous kids of JWT_VERIFY_KEYS_JSON verify too; the verifier never signs and
// holds no private key; staging / prod without keys refuse, naming JWT_PUBLIC_KEY_PEM.
// Keys are generated in the test (node:crypto); no .env file is read.
import { generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  H5_AUDIENCE,
  TokenRejection,
  createTokenKeyProvider,
  createTokenVerifyKeyProvider,
  createTokenVerifyService,
  signScopedToken,
  type TokenService,
  type TokenVerifyKeyProvider,
} from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { readJwtVerifyKeyConfig } from '../../../../apps/api/src/modules/platform/config/jwt.ts';
import {
  CLOUD_ENVS,
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
): Promise<{ readonly keys: TokenVerifyKeyProvider; readonly tokens: TokenService }> {
  const read = readJwtVerifyKeyConfig(appEnv, env);
  expect(read.problems).toEqual([]);
  const keys = await createTokenVerifyKeyProvider(appEnv, read.jwt);
  return { keys, tokens: createTokenVerifyService({ clock: clock(), keys }) };
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
