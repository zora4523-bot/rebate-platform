// Opening the 大淘客 credentials of the Taobao order source (B1-04e, D10-486 ①; same discipline as
// ./taobao-startup.ts of B1-04k). Called by the union module's async startup factory, once, while
// Nest creates the providers, only when taobao is live and AppConfig.dataoke is set: the staging
// appSecret file is read here through ./startup-secret-file.ts (one trailing newline removed) and
// the credentials are handed out from memory afterwards (changing or deleting the file later
// changes nothing). Errors carry a fixed text per code, never the path, the file content, the app
// key or the underlying error (no `cause`); nothing is logged here; no process.env.
// Skeleton: openDataokeCredentials throws NotImplemented.
//
// - local / test: refused, code `live_in_local`, without reading the file.
// - prod: refused until the KMS source exists, code `kms_unavailable`, without reading the file.
//   TODO(规划/11 §4.5): KMS 取用 — blocked on 云 KMS 选型
// - staging: both values required (`credentials_missing` otherwise); the file must be a regular,
//   non-empty UTF-8 file (`secret_unreadable` / `secret_invalid`).
//
// The implementation adds DataokeStartupError (name 'DataokeStartupError', `code`, fixed message
// per code, no cause) and a max file size, as TaobaoStartupError does.
import type { AppEnv } from './app-env.ts';
import type { DataokeAppConfig } from './dataoke.ts';

export type DataokeStartupErrorCode =
  | 'live_in_local'
  | 'kms_unavailable'
  | 'credentials_missing'
  | 'secret_unreadable'
  | 'secret_invalid';

export interface DataokeAppCredentials {
  readonly appKey: string;
  readonly appSecret: string;
}

/**
 * Decides whether the 大淘客 order source may start in `appEnv` and, in staging, reads the secret
 * file once. Resolves with a provider that hands out the credentials read now.
 */
export function openDataokeCredentials(
  appEnv: AppEnv,
  dataoke: DataokeAppConfig | null | undefined,
): Promise<() => Promise<DataokeAppCredentials>> {
  void appEnv;
  void dataoke;
  throw new Error('NotImplemented: openDataokeCredentials');
}
