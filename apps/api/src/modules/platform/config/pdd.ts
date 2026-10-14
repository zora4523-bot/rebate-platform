// Pinduoduo live adapter credentials (B1-04t; approvals #28 ②; 规划/11 §8「真实密钥被本地栈加载」;
// 规划/02 §12.6). Pure: only looks at the given object, reads no file, never echoes a value.
//
// - local / test: setting either variable is refused by startupViolations (./credential-env.ts
//   lists both names), so nothing is read here.
// - staging: both variables set → `{ clientId, secretFile }`; only one set → problem; none → null.
//   The secret file is opened once by the union module's startup factory, never here: AppConfig
//   holds the path, never the secret.
// - prod: the file source is refused (prod only accepts KMS); PDD_CLIENT_ID alone is not kept.
//   TODO(规划/11 §4.5): KMS 取用 — blocked on 云 KMS 选型
import type { AppEnv } from './app-env.ts';

export interface PddClientConfig {
  readonly clientId: string;
  /** Path of the node file whose content is client_secret (staging only). */
  readonly secretFile: string;
}

const set = (env: Readonly<Record<string, string | undefined>>, name: string): boolean =>
  (env[name] ?? '') !== '';

export function readPddConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): { readonly pdd: PddClientConfig | null; readonly problems: readonly string[] } {
  const hasId = set(env, 'PDD_CLIENT_ID');
  const hasFile = set(env, 'PDD_CLIENT_SECRET_FILE');
  if (appEnv === 'local' || appEnv === 'test') return { pdd: null, problems: [] };
  if (appEnv === 'prod') {
    return hasFile
      ? {
          pdd: null,
          problems: [
            'PDD_CLIENT_SECRET_FILE: must not be set when APP_ENV=prod (prod reads the Pinduoduo client secret from KMS only)',
          ],
        }
      : { pdd: null, problems: [] };
  }
  if (hasId && hasFile) {
    return {
      pdd: Object.freeze({
        clientId: env['PDD_CLIENT_ID']!,
        secretFile: env['PDD_CLIENT_SECRET_FILE']!,
      }),
      problems: [],
    };
  }
  if (hasId || hasFile) {
    return {
      pdd: null,
      problems: [
        'PDD_CLIENT_ID, PDD_CLIENT_SECRET_FILE: must be set together when APP_ENV=staging',
      ],
    };
  }
  return { pdd: null, problems: [] };
}
