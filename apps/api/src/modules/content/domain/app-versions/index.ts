export interface AppVersionStoreListing {
  readonly store: string;
  readonly listed_version: string | null;
}

/** Persisted business fields; confirmations belong to the current save request. */
export interface AppVersionSaveRow {
  readonly platform: 'ios' | 'android' | 'harmony';
  readonly channel: 'appstore' | 'official' | 'huawei' | 'agc';
  readonly latest_version: string;
  readonly min_supported_version: string | null;
  readonly recommended_version: string | null;
  readonly update_title: string;
  readonly update_notes: string;
  readonly store_url: string;
  readonly default_store: string;
  readonly store_listings: readonly AppVersionStoreListing[];
}

export interface AppVersionSaveInput extends AppVersionSaveRow {
  readonly confirmed_stores: readonly string[];
}

export type AppVersionSaveField = keyof AppVersionSaveInput;

export type AppVersionSaveValidation =
  | { readonly ok: true; readonly store_table_empty: boolean }
  | {
      readonly ok: false;
      readonly fields: readonly AppVersionSaveField[];
      readonly store_table_empty: boolean;
    };

export type AppVersionSaveCheck =
  | { readonly ok: true; readonly confirmed: readonly string[] }
  | { readonly ok: false; readonly fields: readonly AppVersionSaveField[] };

export type AppVersionMinimum = Pick<AppVersionSaveRow, 'min_supported_version'>;

/** F1-02zb D2–D4: shape/format only; storeKeys are scoped by the caller to platform/channel. */
export function validateAppVersionSave(
  input: unknown,
  storeKeys: readonly string[],
): AppVersionSaveValidation {
  void input;
  void storeKeys;
  throw new Error('NotImplemented: validateAppVersionSave');
}

/** BR-ID-01 / Z1–Z3: inputs have passed validation; failures map to 20001 data.fields. */
export function checkAppVersionSave(
  before: AppVersionSaveRow | null,
  after: AppVersionSaveInput,
): AppVersionSaveCheck {
  void before;
  void after;
  throw new Error('NotImplemented: checkAppVersionSave');
}

/** Z4: the same raise predicate used by the save check and the caller's step-up selection. */
export function isMinSupportedRaise(
  before: AppVersionMinimum | null,
  after: AppVersionMinimum,
): boolean {
  void before;
  void after;
  throw new Error('NotImplemented: isMinSupportedRaise');
}
