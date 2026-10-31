// Names of environment variables that hold real third-party credentials (规划/11 §8, row "真实密钥被
// 本地栈加载"): local and test processes refuse to start when one of them is set, because their
// union / SMS / payout adapters must be fakes.
//
// SMS: the names the Aliyun SendSms channel reads (orchestrator rulings B1-02e §9.3 #8, §9.5 #4;
// D10-315, B1-12w): the AccessKey pair, the signature name and the verification code template
// CODE, all SMS_-prefixed; ./sms.ts reads them in staging / prod only, and any new SMS variable is
// added here. The list lives in platform because loadConfig runs before any module and platform
// imports no module.
//
// Pinduoduo: PDD_CLIENT_ID and PDD_CLIENT_SECRET_FILE, declared by the live adapter wiring (B1-04t).
//
// Taobao: TAOBAO_APP_KEY and TAOBAO_APP_SECRET_FILE, declared by the live adapter wiring (B1-04k).
//
// 大淘客: DATAOKE_APP_KEY and DATAOKE_APP_SECRET_FILE, the Taobao order source (B1-04e).
//
// Jingdong: JD_APP_KEY and JD_APP_SECRET_FILE, declared by the live adapter wiring (B1-04ze).
//
// Agent content safety review (B3-03m; owner D10-135 ②): the Aliyun AccessKey pair of the stream
// entry's input / output review, read by the composition root in staging / prod only.
//
// PROVISIONAL matcher for union, Alipay and bank channels until their adapters declare names.
// TODO(规划/11 §8): replace it with the declared key names of each adapter as they land.
const CREDENTIAL_ENV_NAME =
  /^(?:UNION|ALIPAY|BANK)_(?:[A-Z0-9]+_)*(?:SECRET|PRIVATE_KEY|ACCESS_KEY)$/i;

/**
 * Variables of the Aliyun SendSms channel (B1-12w): AccessKey pair, signature name and template
 * CODE, all SMS_-prefixed. local / test refuse to start when any of them is set.
 */
export const SMS_CREDENTIAL_ENV_NAMES: readonly string[] = Object.freeze([
  'SMS_ACCESS_KEY_ID',
  'SMS_ACCESS_KEY_SECRET',
  'SMS_SIGN_NAME',
  'SMS_TEMPLATE_VERIFY_CODE',
]);

/**
 * Credential variables of the Pinduoduo live adapter (B1-04t; approvals #28 ②): the client id and
 * the path of the node file that holds client_secret. Only staging reads them (./pdd.ts).
 */
export const PDD_CREDENTIAL_ENV_NAMES: readonly string[] = Object.freeze([
  'PDD_CLIENT_ID',
  'PDD_CLIENT_SECRET_FILE',
]);

/**
 * Credential variables of the Taobao live adapter (B1-04k; approvals #28 ②): the app key and the
 * path of the node file that holds app_secret. Only staging reads them (./taobao.ts).
 */
export const TAOBAO_CREDENTIAL_ENV_NAMES: readonly string[] = Object.freeze([
  'TAOBAO_APP_KEY',
  'TAOBAO_APP_SECRET_FILE',
]);

/**
 * Credential variables of the 大淘客 order source of the Taobao live adapter (B1-04e; approvals
 * #28 ②): the app key and the path of the node file that holds the appSecret. Only staging reads
 * them (./dataoke.ts).
 */
export const DATAOKE_CREDENTIAL_ENV_NAMES: readonly string[] = Object.freeze([
  'DATAOKE_APP_KEY',
  'DATAOKE_APP_SECRET_FILE',
]);

/**
 * Credential variables of the Jingdong live adapter (B1-04ze; approvals #28 ②): the app key and the
 * path of the node file that holds app_secret. Only staging reads them (./jd.ts).
 */
export const JD_CREDENTIAL_ENV_NAMES: readonly string[] = Object.freeze([
  'JD_APP_KEY',
  'JD_APP_SECRET_FILE',
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
    ...TAOBAO_CREDENTIAL_ENV_NAMES,
    ...DATAOKE_CREDENTIAL_ENV_NAMES,
    ...JD_CREDENTIAL_ENV_NAMES,
    ...AGENT_REVIEW_CREDENTIAL_ENV_NAMES,
  ].map((name) => name.toUpperCase()),
);

/**
 * True for a declared SMS, Pinduoduo, Taobao, 大淘客, Jingdong or Agent review credential name (compared without regard to case) and for a name with
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
