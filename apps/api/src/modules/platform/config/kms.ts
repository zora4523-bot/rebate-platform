// B1-30a (FU-KMS-ADAPTER): where the Aliyun KMS adapter is configured (规划/02 §12.6, BR-PAY-08 ②;
// endpoint format: docs-mirror/aliyun-kms/pages/endpoint.txt). Skeleton of the rule-test author; the
// rule tests in test/spec/platform/kms/** are the contract. Pure: looks only at the given object,
// reads no file, and a problem never quotes a value.
//
// Variables: KMS_REGION_ID, KMS_ENDPOINT, KMS_KEY_ID, KMS_RAM_ROLE; '' counts as unset.
// - local / test: any of them set → `KMS_*: must not be set when APP_ENV=<appEnv> (local and test
//   never load real keys)`, kms null.
// - staging / prod: none → kms null, no problem; some → `KMS_REGION_ID, KMS_ENDPOINT, KMS_KEY_ID,
//   KMS_RAM_ROLE: must be set together`, kms null.
// - KMS_ENDPOINT is a host name only (no scheme, path or port) ending in .aliyuncs.com, otherwise
//   `KMS_ENDPOINT: must be a host name ending in .aliyuncs.com`.
// loadConfig: `AppConfig.kms` is optional and the key is absent when kms is null; these problems
// come before the keyring problems.
import type { AppEnv } from './app-env.ts';

export interface KmsConfig {
  readonly regionId: string;
  readonly endpoint: string;
  readonly keyId: string;
  readonly ramRole: string;
}

export function readKmsConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): { readonly kms: KmsConfig | null; readonly problems: readonly string[] } {
  void appEnv;
  void env;
  throw new Error('NotImplemented: readKmsConfig');
}
