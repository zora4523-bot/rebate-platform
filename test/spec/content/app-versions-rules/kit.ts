import type { AppVersionSaveInput } from '../../../../apps/api/src/modules/content/domain/app-versions/index.ts';

// Synthetic keys only: no real store keys have been configured in specs/app-stores.yaml.
export function row(overrides: Partial<AppVersionSaveInput> = {}): AppVersionSaveInput {
  return {
    platform: 'android',
    channel: 'official',
    latest_version: '1.1.0',
    min_supported_version: '1.1.0',
    recommended_version: '1.1.0',
    update_title: '更新',
    update_notes: '说明',
    store_url: 'https://store.test/a',
    default_store: 'a',
    store_listings: [
      { store: 'a', listed_version: '1.1.0' },
      { store: 'b', listed_version: '1.1.0' },
    ],
    confirmed_stores: [],
    ...overrides,
  };
}
