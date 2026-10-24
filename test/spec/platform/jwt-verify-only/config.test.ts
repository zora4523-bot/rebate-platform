// B1-02zj (D10-255 ①) configuration layer: JWT_PUBLIC_KEY_PEM and the verify-only reading of the
// JWT_* variables (platform/config/jwt.ts), and what loadConfig accepts in staging / prod.
// - JWT_PUBLIC_KEY_PEM is exactly one SPKI (`PUBLIC KEY`) PEM block on P-256; anything else is a
//   problem named JWT_PUBLIC_KEY_PEM that never quotes the value.
// - JWT_KEY_ID + JWT_PUBLIC_KEY_PEM: the verify-only configuration passes, the signing one reports
//   the missing private key, and loadConfig (shared by every entry) accepts it.
// - JWT_KEY_ID + JWT_PRIVATE_KEY_PEM (existing deployments): the verify-only configuration derives
//   the public key and does not keep the private key.
// - Public and private key together must be one key pair.
// - JWT_VERIFY_KEYS_JSON keeps its rules for the verify-only reading.
// Keys are generated in the test (node:crypto); no .env file is read.
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  JWT_ENV_NAMES,
  readJwtKeyConfig,
  readJwtVerifyKeyConfig,
} from '../../../../apps/api/src/modules/platform/config/jwt.ts';
import {
  CLOUD_ENVS,
  KID,
  PREVIOUS_KID,
  cloudEnv,
  configProblems,
  mentions,
  names,
  p256,
  pemBodyLine,
} from './kit.ts';

/**
 * B3-09j: loadConfig requires AGENT_USER_HASH_KEY when APP_ENV=prod; a synthetic test-only value
 * for the cases that expect loadConfig to accept (staging inputs stay unchanged).
 */
const PROD_AGENT_KEY = { AGENT_USER_HASH_KEY: 'test-only-agent-user-hash-key-jwt-verify-only' };

function prodAgentKey(appEnv: (typeof CLOUD_ENVS)[number]): Record<string, string> {
  return appEnv === 'prod' ? PROD_AGENT_KEY : {};
}

/** True when the PEM text is the same public key as `key`. */
function samePublicKey(pem: string | undefined, key: ReturnType<typeof p256>['publicKey']) {
  return pem !== undefined && createPublicKey(pem).equals(key);
}

/** Every problem text of both readings, for the «never quotes a value» checks. */
function allTexts(first: readonly string[], second: 'loaded' | readonly string[]): string[] {
  return [...first, ...(second === 'loaded' ? [] : second)];
}

it('[D10-255][BR-ID-07] JWT_ENV_NAMES 含 JWT_PUBLIC_KEY_PEM（与其它 JWT_* 一样计入 loadConfig）', () => {
  const listed: readonly string[] = JWT_ENV_NAMES;
  expect(listed).toContain('JWT_PUBLIC_KEY_PEM');
  for (const name of ['JWT_PRIVATE_KEY_PEM', 'JWT_KEY_ID', 'JWT_VERIFY_KEYS_JSON']) {
    expect(listed).toContain(name);
  }
});

for (const appEnv of CLOUD_ENVS) {
  it(`[D10-255][BR-ID-07] ${appEnv}：只给 JWT_KEY_ID 与 JWT_PUBLIC_KEY_PEM，验签配置通过、签发配置报缺私钥，loadConfig 接受`, () => {
    const pair = p256();
    const env = { JWT_KEY_ID: KID, JWT_PUBLIC_KEY_PEM: pair.publicPem };

    const verify = readJwtVerifyKeyConfig(appEnv, env);
    expect(verify.problems).toEqual([]);
    expect(verify.jwt?.kid).toBe(KID);
    expect(verify.jwt?.verificationKeys).toEqual({});
    expect(samePublicKey(verify.jwt?.publicKeyPem, pair.publicKey)).toBe(true);

    const sign = readJwtKeyConfig(appEnv, env);
    expect(sign.jwt).toBeNull();
    expect(names(sign.problems, 'JWT_PRIVATE_KEY_PEM'), sign.problems.join(' | ')).toBe(true);

    expect(configProblems(cloudEnv(appEnv, { ...env, ...prodAgentKey(appEnv) }))).toBe('loaded');
  });

  it(`[D10-255][BR-ID-07] ${appEnv}：只给 JWT_KEY_ID 与 JWT_PRIVATE_KEY_PEM（现有部署），验签配置由私钥导出公钥且不保留私钥，签发配置不变`, () => {
    const pair = p256();
    const env = { JWT_KEY_ID: KID, JWT_PRIVATE_KEY_PEM: pair.privatePem };

    const verify = readJwtVerifyKeyConfig(appEnv, env);
    expect(verify.problems).toEqual([]);
    expect(verify.jwt?.kid).toBe(KID);
    expect(verify.jwt?.verificationKeys).toEqual({});
    expect(samePublicKey(verify.jwt?.publicKeyPem, pair.publicKey)).toBe(true);
    // Least privilege: nothing of the private key travels in the verify-only configuration.
    const text = JSON.stringify(verify.jwt);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain(pemBodyLine(pair.privatePem));

    const sign = readJwtKeyConfig(appEnv, env);
    expect(sign.problems).toEqual([]);
    expect(sign.jwt).toMatchObject({ kid: KID, privateKeyPem: pair.privatePem });
    expect(configProblems(cloudEnv(appEnv, { ...env, ...prodAgentKey(appEnv) }))).toBe('loaded');
  });

  it(`[D10-255][BR-ID-07] ${appEnv}：同时给同一对的公钥与私钥，验签与签发配置都通过`, () => {
    const pair = p256();
    const env = {
      JWT_KEY_ID: KID,
      JWT_PRIVATE_KEY_PEM: pair.privatePem,
      JWT_PUBLIC_KEY_PEM: pair.publicPem,
    };
    const verify = readJwtVerifyKeyConfig(appEnv, env);
    expect(verify.problems).toEqual([]);
    expect(samePublicKey(verify.jwt?.publicKeyPem, pair.publicKey)).toBe(true);
    expect(JSON.stringify(verify.jwt)).not.toContain('PRIVATE KEY');
    const sign = readJwtKeyConfig(appEnv, env);
    expect(sign.problems).toEqual([]);
    expect(sign.jwt).toMatchObject({ kid: KID, privateKeyPem: pair.privatePem });
    expect(configProblems(cloudEnv(appEnv, { ...env, ...prodAgentKey(appEnv) }))).toBe('loaded');
  });

  it(`[D10-255][BR-ID-07] ${appEnv}：公钥与私钥不是同一对是配置错误（验签配置与 loadConfig 都拒绝，不回显密钥）`, () => {
    const signing = p256();
    const other = p256();
    const env = {
      JWT_KEY_ID: KID,
      JWT_PRIVATE_KEY_PEM: signing.privatePem,
      JWT_PUBLIC_KEY_PEM: other.publicPem,
    };
    const verify = readJwtVerifyKeyConfig(appEnv, env);
    const verifyText = verify.problems.join(' | ');
    expect(verify.jwt).toBeNull();
    expect(mentions(verify.problems, 'JWT_PUBLIC_KEY_PEM'), verifyText).toBe(true);
    const problems = configProblems(cloudEnv(appEnv, env));
    expect(problems).not.toBe('loaded');
    expect(mentions(problems, 'JWT_PUBLIC_KEY_PEM'), String(problems)).toBe(true);
    for (const text of allTexts(verify.problems, problems)) {
      expect(text).not.toContain(pemBodyLine(signing.privatePem));
      expect(text).not.toContain(pemBodyLine(other.publicPem));
    }
  });
}

/** JWT_PUBLIC_KEY_PEM values that are not one SPKI PEM block on P-256. */
function malformedPublicKeys(): Record<string, string> {
  const pair = p256();
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey;
  return {
    // PKCS#8 private key where the public key belongs (not SPKI; private material must never be accepted here).
    'pkcs8-private-key': pair.privatePem,
    // PKCS#1 `RSA PUBLIC KEY` block (not SPKI).
    'pkcs1-rsa-public': rsa.export({ type: 'pkcs1', format: 'pem' }).toString(),
    // SPKI, but not P-256.
    'spki-rsa': rsa.export({ type: 'spki', format: 'pem' }).toString(),
    'spki-p384': p384.export({ type: 'spki', format: 'pem' }).toString(),
    // Two SPKI P-256 blocks in one value.
    'two-blocks': `${pair.publicPem}${p256().publicPem}`,
    garbage: 'invalid-public-key-sentinel',
  };
}

for (const appEnv of CLOUD_ENVS) {
  for (const [kind, value] of Object.entries(malformedPublicKeys())) {
    it(`[D10-255][BR-ID-07] ${appEnv}：JWT_PUBLIC_KEY_PEM 格式错（${kind}）报 JWT_PUBLIC_KEY_PEM 问题，loadConfig 拒绝，不回显值`, () => {
      const env = { JWT_KEY_ID: KID, JWT_PUBLIC_KEY_PEM: value };
      const verify = readJwtVerifyKeyConfig(appEnv, env);
      const verifyText = verify.problems.join(' | ');
      expect(verify.jwt).toBeNull();
      expect(names(verify.problems, 'JWT_PUBLIC_KEY_PEM'), verifyText).toBe(true);
      const problems = configProblems(cloudEnv(appEnv, env));
      expect(names(problems, 'JWT_PUBLIC_KEY_PEM'), String(problems)).toBe(true);
      for (const text of allTexts(verify.problems, problems)) {
        expect(text).not.toContain(value.trim());
        expect(text).not.toContain(pemBodyLine(value));
      }
    });
  }

  it(`[D10-255][BR-ID-07] ${appEnv}：私钥正确而 JWT_PUBLIC_KEY_PEM 是两块 PEM 时同样拒绝`, () => {
    const pair = p256();
    const env = {
      JWT_KEY_ID: KID,
      JWT_PRIVATE_KEY_PEM: pair.privatePem,
      JWT_PUBLIC_KEY_PEM: `${pair.publicPem}${pair.publicPem}`,
    };
    const verify = readJwtVerifyKeyConfig(appEnv, env);
    expect(verify.jwt).toBeNull();
    expect(names(verify.problems, 'JWT_PUBLIC_KEY_PEM'), verify.problems.join(' | ')).toBe(true);
    expect(names(configProblems(cloudEnv(appEnv, env)), 'JWT_PUBLIC_KEY_PEM')).toBe(true);
  });

  it(`[D10-255][BR-ID-07] ${appEnv}：公钥私钥都缺时验签配置点名 JWT_PUBLIC_KEY_PEM 与 JWT_KEY_ID；有公钥缺 kid 报 JWT_KEY_ID`, () => {
    const none = readJwtVerifyKeyConfig(appEnv, {});
    const noneText = none.problems.join(' | ');
    expect(none.jwt).toBeNull();
    expect(names(none.problems, 'JWT_PUBLIC_KEY_PEM'), noneText).toBe(true);
    expect(names(none.problems, 'JWT_KEY_ID'), noneText).toBe(true);

    const kidOnly = readJwtVerifyKeyConfig(appEnv, { JWT_KEY_ID: KID });
    const kidOnlyText = kidOnly.problems.join(' | ');
    expect(kidOnly.jwt).toBeNull();
    expect(names(kidOnly.problems, 'JWT_PUBLIC_KEY_PEM'), kidOnlyText).toBe(true);

    const noKid = { JWT_PUBLIC_KEY_PEM: p256().publicPem };
    const missingKid = readJwtVerifyKeyConfig(appEnv, noKid);
    const missingKidText = missingKid.problems.join(' | ');
    expect(missingKid.jwt).toBeNull();
    expect(names(missingKid.problems, 'JWT_KEY_ID'), missingKidText).toBe(true);
    expect(names(configProblems(cloudEnv(appEnv, noKid)), 'JWT_KEY_ID')).toBe(true);
  });

  it(`[D10-255][BR-ID-07] ${appEnv}：验签配置照旧读取 JWT_VERIFY_KEYS_JSON，且其中不得含 JWT_KEY_ID`, () => {
    const current = p256();
    const previous = p256();
    const verificationKeys = { [PREVIOUS_KID]: previous.publicPem };
    const env = {
      JWT_KEY_ID: KID,
      JWT_PUBLIC_KEY_PEM: current.publicPem,
      JWT_VERIFY_KEYS_JSON: JSON.stringify(verificationKeys),
    };
    const verify = readJwtVerifyKeyConfig(appEnv, env);
    expect(verify.problems).toEqual([]);
    expect(verify.jwt?.verificationKeys).toEqual(verificationKeys);
    expect(configProblems(cloudEnv(appEnv, { ...env, ...prodAgentKey(appEnv) }))).toBe('loaded');

    const currentAsPrevious = JSON.stringify({ [KID]: current.publicPem });
    const clash = { ...env, JWT_VERIFY_KEYS_JSON: currentAsPrevious };
    const refused = readJwtVerifyKeyConfig(appEnv, clash);
    const refusedText = refused.problems.join(' | ');
    expect(refused.jwt).toBeNull();
    expect(names(refused.problems, 'JWT_VERIFY_KEYS_JSON'), refusedText).toBe(true);
    expect(names(configProblems(cloudEnv(appEnv, clash)), 'JWT_VERIFY_KEYS_JSON')).toBe(true);
  });
}

it('[D10-255][BR-ID-07] local / test 无 JWT_* 时验签配置为 null 且无问题（现有行为不变）', () => {
  for (const appEnv of ['local', 'test'] as const) {
    expect(readJwtVerifyKeyConfig(appEnv, {})).toEqual({ jwt: null, problems: [] });
    expect(readJwtKeyConfig(appEnv, {})).toEqual({ jwt: null, problems: [] });
  }
});
