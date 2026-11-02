// B1-30a (FU-KMS-ADAPTER): reading secrets from and wrapping keys with Aliyun KMS (规划/02 §12.6,
// BR-PAY-08 ②; docs-mirror/aliyun-kms/pages/). Skeleton of the rule-test author; the rule tests in
// test/spec/platform/kms/** are the contract.
//
// ./sdk.ts is imported dynamically, when the client is first needed: a process without KMS (local,
// test, or KMS_* unset) never loads it, and kmsAccessOf itself imports nothing and sends nothing. One
// client per KmsAccess, also when several factories use it for the first time at once.
// KMS_SECRETS (the table of logical names) is a constant, so the skeleton cannot hold it; the logical
// names are the type KmsSecretName below.
import type { AppEnv } from '../config/app-env.ts';
import type { KmsConfig } from '../config/kms.ts';
import type { KeyProvider } from '../crypto/index.ts';

export type KmsErrorCode = 'kms_read_failed' | 'secret_invalid';

export type KmsSecretName =
  | 'pay/wechat/merchant-private-key'
  | 'pay/wechat/apiv3-key'
  | 'pay/wechat/platform-public-key'
  | 'pay/alipay/app-private-key'
  | 'pay/alipay/public-key'
  | 'pay/alipay/app-cert'
  | 'pay/alipay/public-cert'
  | 'pay/alipay/root-cert'
  | 'union/pdd/client-secret'
  | 'union/taobao/app-secret'
  | 'union/jd/app-secret'
  | 'union/dataoke/app-secret';

/** A fixed text and the code: never the SDK's text, a secret value or a `cause`. */
export class KmsError extends Error {
  readonly code: KmsErrorCode;

  constructor(code: KmsErrorCode) {
    super('NotImplemented: KmsError');
    void code;
    throw new Error('NotImplemented: KmsError');
  }
}

export interface KmsAccess {
  readonly keyProvider: KeyProvider;
  readSecret(logicalName: KmsSecretName, maxBytes: number): Promise<string>;
}

/** Null without KMS; the same object for the same config object. */
export function kmsAccessOf(config: {
  readonly appEnv: AppEnv;
  readonly kms?: KmsConfig | null | undefined;
}): KmsAccess | null {
  void config;
  throw new Error('NotImplemented: kmsAccessOf');
}
