// F1-02zc: the application boundary of the console's app-version save validation (Y2, Y5).
// Store keys come from the generated snapshot of specs/app-stores.yaml (APP_STORES, Y5): the
// non-null keys of the rows serving this platform and channel. While none is filled in, the domain
// validation checks only the format of store keys (D2) and the caller logs a warning.
// F1-02zb's validateAppVersionSave does not check that confirmed_stores are known keys; with a
// non-empty table this boundary adds that check (Y2b; confirmations not needed are ignored later
// only when they are known keys).
import {
  validateAppVersionSave,
  type AppVersionSaveField,
  type AppVersionSaveValidation,
} from '../domain/app-versions/index.ts';
import { APP_STORES } from '../specs/app-stores.gen.ts';

export interface AppVersionStoreEntry {
  readonly key: string | null;
  readonly platform: string;
  readonly channels: readonly string[];
}

/** Y5: default source is the generated table; tests can inject a populated table. */
export function storeKeysFor(
  platform: string,
  channel: string,
  stores: readonly AppVersionStoreEntry[] = APP_STORES.stores,
): readonly string[] {
  const keys: string[] = [];
  for (const store of stores) {
    if (store.key === null || store.platform !== platform || !store.channels.includes(channel)) {
      continue;
    }
    if (!keys.includes(store.key)) keys.push(store.key);
  }
  return keys;
}

/** Application boundary: domain validation plus confirmed_stores membership (Y2). */
export function validateAdminAppVersionSave(
  input: unknown,
  storeKeys: readonly string[],
): AppVersionSaveValidation {
  const result = validateAppVersionSave(input, storeKeys);
  if (storeKeys.length === 0) return result;
  const confirmed =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)['confirmed_stores']
      : undefined;
  const unknownKey =
    Array.isArray(confirmed) &&
    (confirmed as unknown[]).some(
      (store) => typeof store === 'string' && !storeKeys.includes(store),
    );
  if (!unknownKey) return result;
  const fields: AppVersionSaveField[] = result.ok ? [] : [...result.fields];
  if (!fields.includes('confirmed_stores')) fields.push('confirmed_stores');
  return { ok: false, fields, store_table_empty: result.store_table_empty };
}
