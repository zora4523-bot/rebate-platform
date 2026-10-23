// Shared fixtures of the B1-02zj rule tests (D10-255 ①: token keys split by least privilege; the
// signing process keeps JWT_PRIVATE_KEY_PEM + JWT_KEY_ID, a verify-only process needs JWT_KEY_ID
// and JWT_PUBLIC_KEY_PEM, or a private key it derives the public key from).
// Every key is generated here with node:crypto: no key is read from disk or from any .env file.
import { generateKeyPairSync, KeyObject } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createTokenKeyProvider,
  createTokenService,
  type TokenKeyProvider,
  type TokenService,
} from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  ConfigError,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/config/config.ts';
import type { TokenPrincipal } from '../../../../apps/api/src/modules/platform/http/token-context.ts';

export const INSTANT = '2026-10-23T04:00:00.000Z';
/** Seconds since the epoch of INSTANT (iat of the tokens signed here). */
export const ISSUED_AT = Math.floor(Date.parse(INSTANT) / 1000);
export const KID = 'current-2026-10';
export const PREVIOUS_KID = 'previous-2026-09';
export const OTHER_KID = 'unknown-2026-10';
export const CLOUD_ENVS = ['staging', 'prod'] as const;
export type CloudEnv = (typeof CLOUD_ENVS)[number];

export const PRINCIPAL: TokenPrincipal = {
  uid: '019a0000-0000-7000-8000-00000000b102',
  app_id: 'couli',
  sid: 'b1-02zj-session-opaque',
  device_id: '019a0000-0000-7000-8000-00000000d102',
  scp: 'full',
};

export interface PemPair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** PKCS#8 PEM (JWT_PRIVATE_KEY_PEM). */
  readonly privatePem: string;
  /** SPKI PEM (JWT_PUBLIC_KEY_PEM, JWT_VERIFY_KEYS_JSON values). */
  readonly publicPem: string;
}

/** A fresh P-256 (prime256v1) key pair, generated in the test. */
export function p256(): PemPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey,
    publicKey,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** The first base64 line of a PEM block (to search texts for an echoed key). */
export function pemBodyLine(pem: string): string {
  return pem.split('\n').find((line) => line.length > 16 && !line.startsWith('-')) ?? pem;
}

/** Never opened: the cloud configurations below replace the keyring with null before any start. */
const KEYRING_FILE = fileURLToPath(
  new URL('../../../../.tmp/jwt-verify-only/unused-keyring.json', import.meta.url),
);

/** loadConfig input of a cloud environment: a kms keyring (never opened) plus the JWT_* given. */
export function cloudEnv(
  appEnv: CloudEnv,
  jwt: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    APP_ENV: appEnv,
    LOG_LEVEL: 'silent',
    FIELD_KEY_PROVIDER: 'kms',
    FIELD_KEYRING_FILE: KEYRING_FILE,
    ...jwt,
  };
}

export function clock(): FixedClock {
  return new FixedClock(INSTANT);
}

/** A signer as the api entry builds one (B1-02h): kid + PKCS#8 private key, no previous keys. */
export async function signer(
  kid: string,
  pair: PemPair,
): Promise<{ readonly keys: TokenKeyProvider; readonly tokens: TokenService }> {
  const keys = await createTokenKeyProvider('test', {
    kid,
    privateKeyPem: pair.privatePem,
    verificationKeys: {},
  });
  return { keys, tokens: createTokenService({ clock: clock(), keys }) };
}

/** An access token signed by the signing side with `kid` and the private key of `pair`. */
export async function accessToken(kid: string, pair: PemPair): Promise<string> {
  return (await signer(kid, pair)).tokens.issueAccess(PRINCIPAL);
}

export type Settled<T> = { readonly value: T } | { readonly error: unknown };

/** Runs `run` and keeps its value or its error (a red test fails on an assertion, not a throw). */
export async function settle<T>(run: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  }
}

export function settleSync<T>(run: () => T): Settled<T> {
  try {
    return { value: run() };
  } catch (error) {
    return { error };
  }
}

/** What an error says, for assertion messages. */
export function describeError(error: unknown): string {
  if (error instanceof ConfigError) return `ConfigError: ${error.problems.join(' | ')}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** loadConfig's verdict: 'loaded', or the problems it reported (any other error as one problem). */
export function configProblems(
  env: Readonly<Record<string, string>>,
): 'loaded' | readonly string[] {
  try {
    loadConfig(env);
    return 'loaded';
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    return [`not a ConfigError: ${describeError(error)}`];
  }
}

/** True when one of the problems is about `variable` (config problems read `NAME: …`). */
export function names(problems: 'loaded' | readonly string[], variable: string): boolean {
  return problems !== 'loaded' && problems.some((problem) => problem.startsWith(`${variable}:`));
}

/** True when one of the problems mentions `text` anywhere. */
export function mentions(problems: 'loaded' | readonly string[], text: string): boolean {
  return problems !== 'loaded' && problems.some((problem) => problem.includes(text));
}

/** The private keys held directly by an object (a verify-only key port must hold none). */
export function privateKeysIn(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  let count = 0;
  for (const item of Object.values(value)) {
    if (item instanceof KeyObject && item.type === 'private') count += 1;
  }
  return count;
}

/** The same token with one signature byte flipped. */
export function tamperSignature(token: string): string {
  const [header, payload, signature] = token.split('.');
  const bytes = Buffer.from(signature ?? '', 'base64url');
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return `${header ?? ''}.${payload ?? ''}.${bytes.toString('base64url')}`;
}

/** The same token with another uid in its payload and the original signature. */
export function tamperPayload(token: string): string {
  const [header, payload, signature] = token.split('.');
  const text = Buffer.from(payload ?? '', 'base64url').toString();
  const claims = JSON.parse(text) as Record<string, unknown>;
  const forged = { ...claims, uid: '019a0000-0000-7000-8000-00000000beef' };
  const changed = Buffer.from(JSON.stringify(forged)).toString('base64url');
  return `${header ?? ''}.${changed}.${signature ?? ''}`;
}
