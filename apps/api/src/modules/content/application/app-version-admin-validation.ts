import type { AppVersionSaveValidation } from '../domain/app-versions/index.ts';

export interface AppVersionStoreEntry {
  readonly key: string | null;
  readonly platform: string;
  readonly channels: readonly string[];
}

/** Y5: default source is the generated table; tests can inject a populated table. */
export function storeKeysFor(
  platform: string,
  channel: string,
  stores?: readonly AppVersionStoreEntry[],
): readonly string[] {
  void platform;
  void channel;
  void stores;
  throw new Error('NotImplemented: storeKeysFor');
}

/** Application boundary: domain validation plus confirmed_stores membership (Y2). */
export function validateAdminAppVersionSave(
  input: unknown,
  storeKeys: readonly string[],
): AppVersionSaveValidation {
  void input;
  void storeKeys;
  throw new Error('NotImplemented: validateAdminAppVersionSave');
}
