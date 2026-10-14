// Admin console authentication configuration (F1-06k; 08 BR-ID-34; 02 §12.1 admin_token, §12.5
// login IP whitelist ≤ 50; 02 §3.4 admin CORS), consumed only through loadConfig(env):
// ADMIN_TOKEN_SIGNING_KEY: base64url (no padding), at least 32 bytes once decoded; the HS256 key
//   of admin_token, never the app's JWT key.
// ADMIN_IP_ALLOWLIST: comma-separated IP addresses or address/prefix-length ranges, 1 to 50
//   items; every /admin/v1 request (login steps included) must come from one of them.
// ADMIN_CORS_ORIGIN: the exact origin of the admin console front end (scheme, host, optional
//   port; no path, query, wildcard or `null`); unset, the admin entry sends no CORS headers.
// Empty strings count as unset. With none of the three set, AppConfig.adminAuth is null: local /
// test then sign with one random key per process and allow loopback sources only, and staging /
// prod refuse to start when the admin entry initialises (admin's auth module), so that the other
// entries' environments stay valid without these variables (same split as ./jwt.ts). With any of
// them set, staging / prod need the signing key and the whitelist here. No problem text contains
// a configured value.
// Erasable syntax only (this directory is also compiled by the `test` project).
import { isIP } from 'node:net';
import type { AppEnv } from './app-env.ts';

export const ADMIN_AUTH_ENV_NAMES = Object.freeze([
  'ADMIN_TOKEN_SIGNING_KEY',
  'ADMIN_IP_ALLOWLIST',
  'ADMIN_CORS_ORIGIN',
] as const);

/** Most whitelist entries accepted (02 §12.5). */
export const ADMIN_IP_ALLOWLIST_MAX = 50;
/** Smallest decoded signing key accepted (HS256 needs at least the hash size). */
export const ADMIN_TOKEN_KEY_MIN_BYTES = 32;

export interface AdminAuthConfig {
  /** Decoded ADMIN_TOKEN_SIGNING_KEY; null when unset (local / test only). */
  readonly tokenSigningKey: Uint8Array | null;
  /** IP addresses and ranges (`addr/len`); null when unset (local / test: loopback only). */
  readonly ipAllowlist: readonly string[] | null;
  /** Exact origin of the console front end; null: no CORS headers. */
  readonly corsOrigin: string | null;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PREFIX = /^(?:0|[1-9]\d{0,2})$/;
const ORIGIN =
  /^https?:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

const PROBLEMS = Object.freeze({
  keyFormat: `ADMIN_TOKEN_SIGNING_KEY: must be base64url without padding and decode to at least ${String(ADMIN_TOKEN_KEY_MIN_BYTES)} bytes`,
  keyMissing: (appEnv: AppEnv) => `ADMIN_TOKEN_SIGNING_KEY: must be set when APP_ENV=${appEnv}`,
  allowlistFormat:
    'ADMIN_IP_ALLOWLIST: must be a comma-separated list of IP addresses or address/prefix-length ranges (no catch-all range, zone id, netmask or empty item)',
  allowlistSize: `ADMIN_IP_ALLOWLIST: at most ${String(ADMIN_IP_ALLOWLIST_MAX)} entries`,
  allowlistMissing: (appEnv: AppEnv) => `ADMIN_IP_ALLOWLIST: must be set when APP_ENV=${appEnv}`,
  origin:
    'ADMIN_CORS_ORIGIN: must be one exact origin (http or https scheme, host and optional port; no path, query, wildcard or null)',
});

/** True for one IP address or address/prefix-length range (prefix 1–32 / 1–128). */
export function isAllowlistItem(item: string): boolean {
  const slash = item.indexOf('/');
  const address = slash === -1 ? item : item.slice(0, slash);
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (slash === -1) return true;
  const prefix = item.slice(slash + 1);
  if (!PREFIX.test(prefix)) return false;
  const length = Number(prefix);
  return length >= 1 && length <= (family === 4 ? 32 : 128);
}

function readKey(raw: string): Uint8Array | null {
  if (!BASE64URL.test(raw)) return null;
  const decoded = Buffer.from(raw, 'base64url');
  // Buffer drops characters it cannot place; a round trip proves every character was used.
  if (decoded.toString('base64url') !== raw) return null;
  return decoded.length >= ADMIN_TOKEN_KEY_MIN_BYTES ? new Uint8Array(decoded) : null;
}

function exactOrigin(raw: string): boolean {
  if (!ORIGIN.test(raw)) return false;
  try {
    // Browsers send the serialised origin (lower-case host, no default port): compare with it.
    return new URL(raw).origin === raw;
  } catch {
    return false;
  }
}

/**
 * Parses the three variables. `adminAuth` is null when none is set; `problems` lists format
 * problems and, in staging / prod with at least one variable set, the missing key or whitelist.
 */
export function readAdminAuthConfig(
  appEnv: AppEnv | undefined,
  env: Readonly<Record<string, string | undefined>>,
): { readonly adminAuth: AdminAuthConfig | null; readonly problems: readonly string[] } {
  const value = (name: (typeof ADMIN_AUTH_ENV_NAMES)[number]): string | undefined => {
    const raw = env[name];
    return raw === undefined || raw === '' ? undefined : raw;
  };
  const rawKey = value('ADMIN_TOKEN_SIGNING_KEY');
  const rawList = value('ADMIN_IP_ALLOWLIST');
  const rawOrigin = value('ADMIN_CORS_ORIGIN');
  if (rawKey === undefined && rawList === undefined && rawOrigin === undefined) {
    return { adminAuth: null, problems: [] };
  }
  const problems: string[] = [];
  const cloud = appEnv === 'staging' || appEnv === 'prod';

  let tokenSigningKey: Uint8Array | null = null;
  if (rawKey !== undefined) {
    tokenSigningKey = readKey(rawKey);
    if (tokenSigningKey === null) problems.push(PROBLEMS.keyFormat);
  } else if (cloud) {
    problems.push(PROBLEMS.keyMissing(appEnv));
  }

  let ipAllowlist: readonly string[] | null = null;
  if (rawList !== undefined) {
    const items = rawList.split(',').map((item) => item.trim());
    if (!items.every(isAllowlistItem)) problems.push(PROBLEMS.allowlistFormat);
    else if (items.length > ADMIN_IP_ALLOWLIST_MAX) problems.push(PROBLEMS.allowlistSize);
    else ipAllowlist = Object.freeze(items);
  } else if (cloud) {
    problems.push(PROBLEMS.allowlistMissing(appEnv));
  }

  let corsOrigin: string | null = null;
  if (rawOrigin !== undefined) {
    if (exactOrigin(rawOrigin)) corsOrigin = rawOrigin;
    else problems.push(PROBLEMS.origin);
  }

  return problems.length > 0
    ? { adminAuth: null, problems }
    : { adminAuth: Object.freeze({ tokenSigningKey, ipAllowlist, corsOrigin }), problems: [] };
}
