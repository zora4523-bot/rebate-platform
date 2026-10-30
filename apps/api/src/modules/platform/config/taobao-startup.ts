// Starting the real Taobao adapter (B1-04k; same discipline as ./pdd-startup.ts of B1-04t).
// Skeleton only. Called once by the union module's async startup factory: local / test refuse,
// prod refuses until KMS exists, staging reads the app_secret file once (trailing newline removed)
// and hands the credentials out from memory. Errors carry a fixed text per code: no path, file
// content, app key or underlying error (no `cause`).
import type { AppEnv } from './app-env.ts';
import type { TaobaoAppConfig } from './taobao.ts';

export type TaobaoStartupErrorCode =
  | 'live_in_local'
  | 'kms_unavailable'
  | 'credentials_missing'
  | 'secret_unreadable'
  | 'secret_invalid';

/** Every startup refusal of the taobao live adapter; nothing else attached. */
export class TaobaoStartupError extends Error {
  readonly code: TaobaoStartupErrorCode;

  constructor(code: TaobaoStartupErrorCode) {
    super('NotImplemented: TaobaoStartupError');
    void code;
    throw new Error('NotImplemented: TaobaoStartupError');
  }
}

export interface TaobaoAppCredentials {
  readonly appKey: string;
  readonly appSecret: string;
}

/**
 * Decides whether the taobao live adapter may start in `appEnv` and, in staging, reads the secret
 * file once. Resolves with a provider that hands out the credentials read now.
 */
export function openTaobaoCredentials(
  appEnv: AppEnv,
  taobao: TaobaoAppConfig | null | undefined,
): Promise<() => Promise<TaobaoAppCredentials>> {
  void appEnv;
  void taobao;
  throw new Error('NotImplemented: openTaobaoCredentials');
}
