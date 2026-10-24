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

/** The four variables, in the order of SmsConfig's fields. */
const SMS_ENV = {
  accessKeyId: 'SMS_ACCESS_KEY_ID',
  accessKeySecret: 'SMS_ACCESS_KEY_SECRET',
  signName: 'SMS_SIGN_NAME',
  verifyCodeTemplate: 'SMS_TEMPLATE_VERIFY_CODE',
} as const;

export function readSmsConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): SmsConfig | undefined {
  if (appEnv !== 'staging' && appEnv !== 'prod') return undefined;
  const read = (name: string): string | undefined => {
    const value = env[name];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };
  const accessKeyId = read(SMS_ENV.accessKeyId);
  const accessKeySecret = read(SMS_ENV.accessKeySecret);
  const signName = read(SMS_ENV.signName);
  const verifyCodeTemplate = read(SMS_ENV.verifyCodeTemplate);
  if (
    accessKeyId === undefined ||
    accessKeySecret === undefined ||
    signName === undefined ||
    verifyCodeTemplate === undefined
  ) {
    return undefined;
  }
  return Object.freeze({ accessKeyId, accessKeySecret, signName, verifyCodeTemplate });
}
