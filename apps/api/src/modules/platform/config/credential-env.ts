// Names of environment variables that hold real third-party credentials (规划/11 §8, row "真实密钥被
// 本地栈加载"): local and test processes refuse to start when one of them is set, because their
// union / SMS / payout adapters must be fakes.
//
// SMS: the names the SMS adapter declares (orchestrator ruling B1-02e §9.3 #8, §9.5 #4). Every SMS
// variable starts with SMS_; the real provider adapter (a later task, in notification) reads its
// credentials from these names only and adds any new one here. The list lives in platform because
// loadConfig runs before any module and platform imports no module.
//
// Pinduoduo: PDD_CLIENT_ID and PDD_CLIENT_SECRET_FILE, declared by the live adapter wiring (B1-04t).
//
// Agent content safety review (B3-03m; owner D10-135 ②): the Aliyun AccessKey pair of the stream
// entry's input / output review, read by the composition root in staging / prod only.
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

/**
 * Credential variables of the Pinduoduo live adapter (B1-04t; approvals #28 ②): the client id and
 * the path of the node file that holds client_secret. Only staging reads them (./pdd.ts).
 */
export const PDD_CREDENTIAL_ENV_NAMES: readonly string[] = Object.freeze([
  'PDD_CLIENT_ID',
  'PDD_CLIENT_SECRET_FILE',
]);

/** Credential variables of the Agent content safety review (Aliyun AccessKey pair, B3-03m). */
export const AGENT_REVIEW_CREDENTIAL_ENV_NAMES: readonly string[] = Object.freeze([
  'AGENT_REVIEW_ALIYUN_ACCESS_KEY_ID',
  'AGENT_REVIEW_ALIYUN_ACCESS_KEY_SECRET',
]);

const DECLARED_NAMES = new Set(
  [
    ...SMS_CREDENTIAL_ENV_NAMES,
    ...PDD_CREDENTIAL_ENV_NAMES,
    ...AGENT_REVIEW_CREDENTIAL_ENV_NAMES,
  ].map((name) => name.toUpperCase()),
);

/**
 * True for a declared SMS, Pinduoduo or Agent review credential name (compared without regard to case) and for a name with
 * prefix UNION_/ALIPAY_/BANK_ and suffix _SECRET/_PRIVATE_KEY/_ACCESS_KEY.
 */
export function looksLikeRealCredentialEnvName(name: string): boolean {
  return DECLARED_NAMES.has(name.toUpperCase()) || CREDENTIAL_ENV_NAME.test(name);
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

/**
 * The Agent review's AccessKey pair, read by ./agent-review.ts for loadConfig (B3-03m). local / test never
 * read the values (their review stays fail-closed, and loadConfig already refuses to start when
 * either name is set there). staging / prod: both halves set and non-blank, else undefined. The
 * values are returned as set; nothing is logged and no error carries them.
 */
export function readAgentReviewCredentials(
  appEnv: 'local' | 'test' | 'staging' | 'prod',
  env: Readonly<Record<string, string | undefined>>,
): { readonly accessKeyId: string; readonly accessKeySecret: string } | undefined {
  if (appEnv !== 'staging' && appEnv !== 'prod') return undefined;
  const accessKeyId = env['AGENT_REVIEW_ALIYUN_ACCESS_KEY_ID'];
  const accessKeySecret = env['AGENT_REVIEW_ALIYUN_ACCESS_KEY_SECRET'];
  if (typeof accessKeyId !== 'string' || accessKeyId.trim() === '') return undefined;
  if (typeof accessKeySecret !== 'string' || accessKeySecret.trim() === '') return undefined;
  return Object.freeze({ accessKeyId, accessKeySecret });
}
