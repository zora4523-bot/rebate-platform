// SMS provider settings (B1-12w; orchestrator ruling D10-315): the Aliyun AccessKey pair, the
// signature name and the template CODE of the verification code SMS. Pure: only looks at the
// given object, never echoes a value.
//
// - local / test: nothing is read (their sender stays the fake); setting any of the four names is
//   refused by startupViolations (./credential-env.ts lists them in SMS_CREDENTIAL_ENV_NAMES).
// - staging / prod: SMS_ACCESS_KEY_ID, SMS_ACCESS_KEY_SECRET, SMS_SIGN_NAME and
//   SMS_TEMPLATE_VERIFY_CODE all set and non-blank → the frozen config; any of them missing or
//   blank → undefined, and the entry keeps the sender that rejects every message.
import type { AppEnv } from './app-env.ts';

export interface SmsConfig {
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  /** 短信签名名称 (SignName), as registered with the provider. */
  readonly signName: string;
  /** Template CODE (TemplateCode) of the verification code SMS. */
  readonly verifyCodeTemplate: string;
}

export function readSmsConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): SmsConfig | undefined {
  void appEnv;
  void env;
  throw new Error('NotImplemented: readSmsConfig');
}
