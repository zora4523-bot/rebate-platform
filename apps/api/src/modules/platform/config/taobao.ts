// Taobao live adapter credentials (B1-04k; same rules as ./pdd.ts of B1-04t): TAOBAO_APP_KEY and
// TAOBAO_APP_SECRET_FILE. Skeleton only: the implementation follows ./pdd.ts.
// - local / test: setting either variable is refused by startupViolations (./credential-env.ts).
// - staging: both set → `{ appKey, secretFile }`; only one set → problem (names only); none → null.
// - prod: TAOBAO_APP_SECRET_FILE is refused (prod only accepts KMS).
import type { AppEnv } from './app-env.ts';

export interface TaobaoAppConfig {
  readonly appKey: string;
  /** Path of the node file whose content is app_secret (staging only). */
  readonly secretFile: string;
}

export function readTaobaoConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): { readonly taobao: TaobaoAppConfig | null; readonly problems: readonly string[] } {
  void appEnv;
  void env;
  throw new Error('NotImplemented: readTaobaoConfig');
}
