import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import type { AppEnv } from './app-env.ts';

// B1-02h configuration contract, consumed only through loadConfig(env):
// JWT_PRIVATE_KEY_PEM: P-256 PKCS#8 PEM text (no path, no remote key lookup).
// JWT_KEY_ID: nonempty kid, required together with JWT_PRIVATE_KEY_PEM.
// JWT_VERIFY_KEYS_JSON: optional JSON object mapping previous kids to P-256 SPKI public PEMs.
// JWT_VERIFY_KEYS_JSON must not contain JWT_KEY_ID; a duplicate is a configuration problem.
// Empty strings count as unset. Local/test with all three unset -> jwt=null; the process creates
// one ephemeral key pair at startup. Staging/prod require explicit signing configuration.
// readJwtKeyConfig reports missing cloud configuration, but loadConfig only aggregates format
// problems when JWT variables are set; missing cloud keys are rejected by createTokenKeyProvider
// at startup, preserving existing loadConfig validation. No error contains configuration values.
// AppConfig.jwt carries the result; private PEM must never enter logs or .env.example.
//
// Implementation notes (B1-02h; signing key of the api entry, 规划/02 §12.6 JWT 签名私钥, ADR-0001
// §2 自有 KeyProvider 接口):
// - JWT_PRIVATE_KEY_PEM is exactly one PEM block labelled `PRIVATE KEY` (PKCS#8, unencrypted);
//   the SEC1 form labelled `EC PRIVATE KEY` that openssl writes by default is refused (convert it
//   with `openssl pkcs8 -topk8 -nocrypt`). Its curve must be P-256 (prime256v1), the ES256 curve.
// - A kid is 1 to 64 characters of A–Z a–z 0–9 . _ ~ - (it travels in every JWT header).
// - JWT_VERIFY_KEYS_JSON values are each exactly one PEM block labelled `PUBLIC KEY` (SPKI) on
//   P-256; they verify tokens signed before a rotation and never sign.
// - The values are kept exactly as given (the key provider of identity parses them again).
// Erasable syntax only (this directory is also compiled by the `test` project).

/** The three variables of this contract (loadConfig merges their problems only when one is set). */
export const JWT_ENV_NAMES = Object.freeze([
  'JWT_PRIVATE_KEY_PEM',
  'JWT_KEY_ID',
  'JWT_VERIFY_KEYS_JSON',
] as const);

export interface JwtKeyConfig {
  readonly kid: string;
  readonly privateKeyPem: string;
  readonly verificationKeys: Readonly<Record<string, string>>;
}

const KEY_ID = /^[A-Za-z0-9._~-]{1,64}$/;
/** One PEM block (RFC 7468): its label, base64 lines, and the END line repeating the label. */
const PEM_BLOCK = /^-----BEGIN ([A-Z0-9 ]+)-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END \1-----$/;
const PKCS8_LABEL = 'PRIVATE KEY';
const SPKI_LABEL = 'PUBLIC KEY';

/** True for a key id this contract accepts (also used for the kids of JWT_VERIFY_KEYS_JSON). */
export function isJwtKeyId(kid: string): boolean {
  return KEY_ID.test(kid);
}

/** The label of a text that is exactly one PEM block (surrounding whitespace aside), or null. */
function pemLabel(text: string): string | null {
  return PEM_BLOCK.exec(text.trim())?.[1] ?? null;
}

function isP256(key: KeyObject): boolean {
  return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
}

/** The P-256 private key of a single unencrypted PKCS#8 PEM block, or null. */
export function parseP256PrivateKeyPem(pem: string): KeyObject | null {
  if (pemLabel(pem) !== PKCS8_LABEL) return null;
  try {
    const key = createPrivateKey({ key: pem, format: 'pem' });
    return isP256(key) ? key : null;
  } catch {
    return null;
  }
}

/** The P-256 public key of a single SPKI PEM block, or null. */
export function parseP256PublicKeyPem(pem: string): KeyObject | null {
  if (pemLabel(pem) !== SPKI_LABEL) return null;
  try {
    const key = createPublicKey({ key: pem, format: 'pem' });
    return key.type === 'public' && isP256(key) ? key : null;
  } catch {
    return null;
  }
}

function variable(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  return typeof value === 'string' ? value : '';
}

const VERIFY_KEYS_SHAPE =
  'JWT_VERIFY_KEYS_JSON: must be a JSON object mapping key ids (1 to 64 characters of A-Z a-z 0-9 . _ ~ -) to P-256 public keys in SPKI PEM';

/** The previous verification keys, or the problem (never quoting the text). */
function readVerificationKeys(
  text: string,
  kid: string,
): { readonly keys: Readonly<Record<string, string>> | null; readonly problems: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { keys: null, problems: [VERIFY_KEYS_SHAPE] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { keys: null, problems: [VERIFY_KEYS_SHAPE] };
  }
  const entries = Object.entries(parsed);
  const wellFormed = entries.every(
    ([id, pem]) => isJwtKeyId(id) && typeof pem === 'string' && parseP256PublicKeyPem(pem) !== null,
  );
  if (!wellFormed) return { keys: null, problems: [VERIFY_KEYS_SHAPE] };
  if (kid !== '' && entries.some(([id]) => id === kid)) {
    return {
      keys: null,
      problems: [
        'JWT_VERIFY_KEYS_JSON: must not contain JWT_KEY_ID (the current verification key comes from JWT_PRIVATE_KEY_PEM)',
      ],
    };
  }
  return { keys: Object.freeze(Object.fromEntries(entries as [string, string][])), problems: [] };
}

export function readJwtKeyConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): { readonly jwt: JwtKeyConfig | null; readonly problems: readonly string[] } {
  const privateKeyPem = variable(env, 'JWT_PRIVATE_KEY_PEM');
  const kid = variable(env, 'JWT_KEY_ID');
  const verifyKeys = variable(env, 'JWT_VERIFY_KEYS_JSON');
  const cloud = appEnv === 'staging' || appEnv === 'prod';
  const problems: string[] = [];

  if (privateKeyPem === '' && kid === '' && verifyKeys === '') {
    if (cloud) {
      problems.push(
        `JWT_PRIVATE_KEY_PEM: must be set when APP_ENV=${appEnv}`,
        `JWT_KEY_ID: must be set when APP_ENV=${appEnv}`,
      );
    }
    return { jwt: null, problems };
  }
  if (privateKeyPem === '') {
    problems.push('JWT_PRIVATE_KEY_PEM: must be set together with JWT_KEY_ID');
  } else if (parseP256PrivateKeyPem(privateKeyPem) === null) {
    problems.push(
      'JWT_PRIVATE_KEY_PEM: must be one unencrypted P-256 (prime256v1) private key in PKCS#8 PEM',
    );
  }
  if (kid === '') {
    problems.push('JWT_KEY_ID: must be set together with JWT_PRIVATE_KEY_PEM');
  } else if (!isJwtKeyId(kid)) {
    problems.push('JWT_KEY_ID: must be 1 to 64 characters of A-Z a-z 0-9 . _ ~ -');
  }
  let verificationKeys: Readonly<Record<string, string>> = Object.freeze({});
  if (verifyKeys !== '') {
    const read = readVerificationKeys(verifyKeys, kid);
    problems.push(...read.problems);
    if (read.keys !== null) verificationKeys = read.keys;
  }
  if (problems.length > 0) return { jwt: null, problems };
  return { jwt: Object.freeze({ kid, privateKeyPem, verificationKeys }), problems };
}
