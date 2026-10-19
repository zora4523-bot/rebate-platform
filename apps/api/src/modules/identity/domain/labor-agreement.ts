// Labor agreement (规划/08 BR-WDR-31, BR-ID-12; task B1-13h §9.2): the configuration it is read from,
// the signing state, and the check of a signature request. Pure functions: no Nest, no data access.
//
// Configuration (config_items of the app, rulings E10 / E31; values provided by the owner, never
// invented here):
//   legal.labor_agreement.version              positive integer (int32), the currently effective version
//   legal.labor_agreement.text_url             http(s) URL of that version's full text
//   legal.labor_agreement.text_sha256          64 lower-case hex characters, digest of that text
//   legal.labor_agreement.resign_from_version  positive integer ≤ version: signatures of an older
//                                              version no longer count (版本标记需重签)
//   legal.operator_entity.name                 the platform's operating entity (signing only)
//   legal.operator_entity.credit_code          its unified social credit code (signing only)
// A missing key or a value outside these shapes is a configuration fault: the first such key is
// reported (the caller answers 50001 and logs the key only), nothing falls back to a default.
//
// Signing state (E29, 08「签一次对后续提现持续有效，直到后台发布需重签的新版本」): the user's latest
// user-level labor_agreement record (latest server_at, then the largest id: BR-ID-12 current
// state). need_sign = none, or not accepted, or its version < resign_from_version.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.

export const LABOR_AGREEMENT_KEYS = Object.freeze({
  version: 'legal.labor_agreement.version',
  textUrl: 'legal.labor_agreement.text_url',
  textSha256: 'legal.labor_agreement.text_sha256',
  resignFromVersion: 'legal.labor_agreement.resign_from_version',
} as const);

export const OPERATOR_ENTITY_KEYS = Object.freeze({
  name: 'legal.operator_entity.name',
  creditCode: 'legal.operator_entity.credit_code',
} as const);

/** The keys the agreement metadata needs (GET, need_sign, the withdrawal port). */
export const AGREEMENT_CONFIG_KEYS: readonly string[] = Object.freeze(
  Object.values(LABOR_AGREEMENT_KEYS),
);
/** The keys a signature needs: the agreement metadata and the operating entity. */
export const SIGNING_CONFIG_KEYS: readonly string[] = Object.freeze([
  ...AGREEMENT_CONFIG_KEYS,
  ...Object.values(OPERATOR_ENTITY_KEYS),
]);

export interface LaborAgreementConfig {
  readonly version: number;
  readonly text_url: string;
  readonly text_sha256: string;
  readonly resign_from_version: number;
}

export interface OperatorEntity {
  readonly name: string;
  readonly credit_code: string;
}

export type ConfigParse<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly key: string };

/** consent_records.version and the contract's int32. */
const MAX_VERSION = 2_147_483_647;
const SHA256 = /^[0-9a-f]{64}$/;
/** 统一社会信用代码 (GB 32100-2015): 18 characters of digits and upper-case letters without I O Z S V. */
const CREDIT_CODE = /^[0-9A-HJ-NPQRTUWXY]{18}$/;
const MAX_ENTITY_NAME_LENGTH = 200;

function isVersion(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_VERSION
  );
}

function isTextUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value === '') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isEntityName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.trim() === value &&
    [...value].length <= MAX_ENTITY_NAME_LENGTH
  );
}

/** `values`: the configured value of each key present (absent keys are missing). */
export function parseLaborAgreementConfig(
  values: ReadonlyMap<string, unknown>,
): ConfigParse<LaborAgreementConfig> {
  const version = values.get(LABOR_AGREEMENT_KEYS.version);
  if (!isVersion(version)) return { ok: false, key: LABOR_AGREEMENT_KEYS.version };
  const textUrl = values.get(LABOR_AGREEMENT_KEYS.textUrl);
  if (!isTextUrl(textUrl)) return { ok: false, key: LABOR_AGREEMENT_KEYS.textUrl };
  const textSha256 = values.get(LABOR_AGREEMENT_KEYS.textSha256);
  if (typeof textSha256 !== 'string' || !SHA256.test(textSha256)) {
    return { ok: false, key: LABOR_AGREEMENT_KEYS.textSha256 };
  }
  const resign = values.get(LABOR_AGREEMENT_KEYS.resignFromVersion);
  // A threshold above the current version could never be met by signing: a fault, not a block.
  if (!isVersion(resign) || resign > version) {
    return { ok: false, key: LABOR_AGREEMENT_KEYS.resignFromVersion };
  }
  return {
    ok: true,
    value: { version, text_url: textUrl, text_sha256: textSha256, resign_from_version: resign },
  };
}

export function parseOperatorEntity(
  values: ReadonlyMap<string, unknown>,
): ConfigParse<OperatorEntity> {
  const name = values.get(OPERATOR_ENTITY_KEYS.name);
  if (!isEntityName(name)) return { ok: false, key: OPERATOR_ENTITY_KEYS.name };
  const creditCode = values.get(OPERATOR_ENTITY_KEYS.creditCode);
  if (typeof creditCode !== 'string' || !CREDIT_CODE.test(creditCode)) {
    return { ok: false, key: OPERATOR_ENTITY_KEYS.creditCode };
  }
  return { ok: true, value: { name, credit_code: creditCode } };
}

/** The user's current labor_agreement record (BR-ID-12: latest server_at, then the largest id). */
export interface LaborAgreementRecord {
  readonly version: number;
  readonly accepted: boolean;
  readonly server_at: Date;
}

export interface SigningState {
  readonly need_sign: boolean;
  readonly signed_version: number | null;
  readonly signed_at: Date | null;
}

/** need_sign and the latest signature from the user's current labor_agreement record. */
export function signingState(
  latest: LaborAgreementRecord | undefined,
  config: Pick<LaborAgreementConfig, 'resign_from_version'>,
): SigningState {
  if (latest === undefined || !latest.accepted) {
    return { need_sign: true, signed_version: null, signed_at: null };
  }
  return {
    need_sign: latest.version < config.resign_from_version,
    signed_version: latest.version,
    signed_at: latest.server_at,
  };
}

export interface SignatureRequest {
  readonly version: unknown;
  readonly text_sha256: unknown;
  readonly agreed: unknown;
}

/**
 * The fields of a signature request that do not match what is currently effective (E20; contract
 * signLaborAgreement): version ≠ current, text_sha256 ≠ the current digest, agreed ≠ true. Empty
 * when the request may be recorded. Every mismatching field is listed, in this order.
 */
export function signatureMismatches(
  request: SignatureRequest,
  config: Pick<LaborAgreementConfig, 'version' | 'text_sha256'>,
): string[] {
  const fields: string[] = [];
  if (request.version !== config.version) fields.push('version');
  if (request.text_sha256 !== config.text_sha256) fields.push('text_sha256');
  if (request.agreed !== true) fields.push('agreed');
  return fields;
}
