// PROVISIONAL matcher (规划/11 §8, row "真实密钥被本地栈加载"): names of environment variables
// that look like real third-party credentials. Local and test processes refuse to start when
// one of them is set, because their union / SMS / payout adapters must be fakes.
// Replace it with the real adapter key list when the first adapter task lands.
// TODO(规划/11 §8): derive the list from the adapters' declared key names — blocked on B1-01.
const CREDENTIAL_ENV_NAME =
  /^(?:UNION|ALIPAY|BANK|SMS)_(?:[A-Z0-9]+_)*(?:SECRET|PRIVATE_KEY|ACCESS_KEY)$/i;

/** True when `name` has prefix UNION_/ALIPAY_/BANK_/SMS_ and suffix _SECRET/_PRIVATE_KEY/_ACCESS_KEY. */
export function looksLikeRealCredentialEnvName(name: string): boolean {
  return CREDENTIAL_ENV_NAME.test(name);
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
