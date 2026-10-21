// Private export store settings (B1-34d; 08 BR-ID-34 细则「后台导出任务」: every download is
// re-authorized and gets a freshly signed, short-lived link; 02 §4: the `exports` bucket is private),
// consumed only through loadConfig(env):
// EXPORT_STORE_BASE_URL: absolute HTTPS base without credentials, query or fragment.
// EXPORT_STORE_SIGNING_KEY: HMAC key for the local/test stand-in, never logged.
// Unset/empty local/test values use https://exports.local.invalid and a local-only test key.
// Unset/empty staging/prod values remain undefined; missing OSS never blocks startup (every store
// request then fails per request with 50001 until the OSS adapter lands, B1-30).
// No problem text contains a configured value.
// Erasable syntax only (this directory is also compiled by the `test` project).
import type { AppEnv } from './app-env.ts';

export const EXPORT_STORE_ENV_NAMES = Object.freeze({
  baseUrl: 'EXPORT_STORE_BASE_URL',
  signingKey: 'EXPORT_STORE_SIGNING_KEY',
} as const);

/** Base URL used by local / test when EXPORT_STORE_BASE_URL is unset (RFC 2606 `.invalid`). */
export const EXPORT_STORE_DEFAULT_LOCAL_BASE_URL = 'https://exports.local.invalid';

/**
 * Signing key used by local / test when EXPORT_STORE_SIGNING_KEY is unset. Public by design: it only
 * signs links of the in-memory stand-in, which never runs in staging / prod.
 */
export const EXPORT_STORE_DEFAULT_LOCAL_SIGNING_KEY =
  'local-only-export-store-signing-key-not-secret';

export interface ExportStoreConfig {
  readonly exportStoreBaseUrl: string | undefined;
  readonly exportStoreSigningKey: string | undefined;
}

const BASE_URL_PROBLEM =
  'EXPORT_STORE_BASE_URL: must be an absolute https URL with a host (no query, fragment, credentials or whitespace)';

function isExportBaseUrl(raw: string): boolean {
  if (!raw.startsWith('https://')) return false;
  if (/[\s?#\\]/.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === ''
  );
}

/**
 * Parses the export store variables. Each value is the configured value as given, the local / test
 * default when unset there, or undefined when unset in staging / prod (or APP_ENV is invalid).
 */
export function readExportStoreConfig(
  appEnv: AppEnv | undefined,
  env: Readonly<Record<string, string | undefined>>,
): ExportStoreConfig & { readonly problems: readonly string[] } {
  const local = appEnv === 'local' || appEnv === 'test';
  const problems: string[] = [];

  const rawBase = env[EXPORT_STORE_ENV_NAMES.baseUrl];
  let exportStoreBaseUrl: string | undefined;
  if (rawBase === undefined || rawBase === '') {
    exportStoreBaseUrl = local ? EXPORT_STORE_DEFAULT_LOCAL_BASE_URL : undefined;
  } else if (isExportBaseUrl(rawBase)) {
    exportStoreBaseUrl = rawBase;
  } else {
    problems.push(BASE_URL_PROBLEM);
  }

  const rawKey = env[EXPORT_STORE_ENV_NAMES.signingKey];
  const exportStoreSigningKey =
    rawKey === undefined || rawKey === ''
      ? local
        ? EXPORT_STORE_DEFAULT_LOCAL_SIGNING_KEY
        : undefined
      : rawKey;

  return { exportStoreBaseUrl, exportStoreSigningKey, problems };
}
