export { APP_ENVS, ConfigError, LOG_LEVELS, loadConfig, startupViolations } from './config.ts';
export type { AppConfig, AppEnv, LogLevel } from './config.ts';
export {
  PDD_CREDENTIAL_ENV_NAMES,
  SMS_CREDENTIAL_ENV_NAMES,
  findCredentialLikeEnvNames,
  looksLikeRealCredentialEnvName,
} from './credential-env.ts';
// The access-token signing key contract (B1-02h): identity's key provider parses the PEM values
// with the same functions loadConfig validated them with.
export {
  JWT_ENV_NAMES,
  isJwtKeyId,
  parseP256PrivateKeyPem,
  parseP256PublicKeyPem,
  readJwtKeyConfig,
} from './jwt.ts';
// Admin console authentication (F1-06k): admin_token key, login IP whitelist, console CORS origin.
export {
  ADMIN_AUTH_ENV_NAMES,
  ADMIN_IP_ALLOWLIST_MAX,
  ADMIN_TOKEN_KEY_MIN_BYTES,
  isAllowlistItem,
  readAdminAuthConfig,
} from './admin-auth.ts';
export type { AdminAuthConfig } from './admin-auth.ts';
// Media public base URL (F1-06z): https base of content-addressed media files.
export { MEDIA_DEFAULT_LOCAL_BASE_URL, MEDIA_ENV_NAME, readMediaConfig } from './media.ts';
export { readExportStoreConfig } from './export-store.ts';
export type { ExportStoreConfig } from './export-store.ts';
// Pinduoduo live adapter credentials (B1-04t): staging reads the secret file once at startup.
export { readPddConfig } from './pdd.ts';
export type { PddClientConfig } from './pdd.ts';
// Pinduoduo query identity custom_parameters (B1-04x): optional server setting, not a credential.
export {
  PDD_QUERY_CUSTOM_PARAMETERS_ENV,
  PDD_QUERY_CUSTOM_PARAMETERS_MAX_BYTES,
  readPddQueryConfig,
} from './pdd-query.ts';
export {
  PDD_SECRET_FILE_MAX_BYTES,
  PDD_STARTUP_MESSAGES,
  PddStartupError,
  openPddCredentials,
} from './pdd-startup.ts';
export type { PddClientCredentials, PddStartupErrorCode } from './pdd-startup.ts';
// Union endpoint override directory (B1-04y): staging reads the endpoints from a mounted directory.
export {
  UNION_ENDPOINT_OVERRIDE_DIR_ENV,
  readUnionEndpointOverrideConfig,
} from './union-endpoint-override.ts';
