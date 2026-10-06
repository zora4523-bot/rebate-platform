// Names of environment variables that hold real third-party credentials (规划/11 §8, row "真实密钥被
// 本地栈加载"): local and test processes refuse to start when one of them is set, because their
// union / SMS / payout adapters must be fakes.
//
// SMS: the names the SMS adapter declares (orchestrator ruling B1-02e §9.3 #8, §9.5 #4). Every SMS
// variable starts with SMS_; the real provider adapter (a later task, in notification) reads its
// credentials from these names only and adds any new one here. The list lives in platform because
// loadConfig runs before any module and platform imports no module; identity's
// smsCredentialEnvNames() returns this list.
//
// PROVISIONAL matcher for union, Alipay and bank channels until their adapters declare names.
// TODO(规划/11 §8): replace it with the declared key names of each adapter as they land.
const CREDENTIAL_ENV_NAME =
  /^(?:UNION|ALIPAY|BANK)_(?:[A-Z0-9]+_)*(?:SECRET|PRIVATE_KEY|ACCESS_KEY)$/i;

/** Credential variables of the SMS provider adapter (Aliyun AccessKey pair), all SMS_-prefixed. */
export const SMS_CREDENTIAL_ENV_NAMES: readonly string[] = Object.freeze([
  'SMS_ALIYUN_ACCESS_KEY_ID',
  'SMS_ALIYUN_ACCESS_KEY_SECRET',
]);

const SMS_NAMES = new Set(SMS_CREDENTIAL_ENV_NAMES.map((name) => name.toUpperCase()));

/**
 * True for a declared SMS credential name (compared without regard to case) and for a name with
 * prefix UNION_/ALIPAY_/BANK_ and suffix _SECRET/_PRIVATE_KEY/_ACCESS_KEY.
 */
export function looksLikeRealCredentialEnvName(name: string): boolean {
  return SMS_NAMES.has(name.toUpperCase()) || CREDENTIAL_ENV_NAME.test(name);
}

/** Names (never values) of credential-looking variables that are set to a non-empty value. */
export function findCredentialLikeEnvNames(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.keys(env)
    .filter((name) => looksLikeRealCredentialEnvName(name))
    .filter((name) => (env[name] ?? '') !== '')
    .sort();
}
