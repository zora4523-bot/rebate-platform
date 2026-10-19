import type { AppEnv } from './app-env.ts';

export interface ExportStoreConfig {
  readonly exportStoreBaseUrl: string | undefined;
  readonly exportStoreSigningKey: string | undefined;
}

/**
 * EXPORT_STORE_BASE_URL: absolute HTTPS base without credentials, query or fragment.
 * EXPORT_STORE_SIGNING_KEY: HMAC key for the local/test stand-in, never logged.
 * Unset/empty local/test values use https://exports.local.invalid and a local-only test key.
 * Unset/empty staging/prod values remain undefined; missing OSS never blocks startup.
 * loadConfig must consume this parser and expose the two config properties.
 */
export function readExportStoreConfig(
  appEnv: AppEnv | undefined,
  env: Readonly<Record<string, string | undefined>>,
): ExportStoreConfig & { readonly problems: readonly string[] } {
  void appEnv;
  void env;
  throw new Error('NotImplemented: readExportStoreConfig');
}
