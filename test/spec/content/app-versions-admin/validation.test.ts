import { expect, it } from 'vitest';
import {
  storeKeysFor,
  validateAdminAppVersionSave,
} from '../../../../apps/api/src/modules/content/application/app-version-admin-validation.ts';
import { readFileSync } from 'node:fs';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

// Synthetic injected table, independent of the unfilled production store identifiers.
const body = {
  platform: 'android',
  channel: 'official',
  latest_version: '1.0.0',
  min_supported_version: null,
  recommended_version: null,
  update_title: '',
  update_notes: '',
  store_url: 'https://store.example.test/app',
  default_store: 'store_a',
  store_listings: [{ store: 'store_a', listed_version: '1.0.0' }],
  confirmed_stores: [],
};

it('[AC-F1-02zc#25] 商店键只取相同端渠道的非 null 值，支持注入的非空表', () => {
  const table = [
    { key: null, platform: 'android', channels: ['official'] },
    { key: 'store_a', platform: 'android', channels: ['official', 'huawei'] },
    { key: 'store_b', platform: 'android', channels: ['official'] },
    { key: 'store_c', platform: 'ios', channels: ['appstore'] },
  ];
  expect(storeKeysFor('android', 'official', table)).toEqual(['store_a', 'store_b']);
  expect(storeKeysFor('android', 'huawei', table)).toEqual(['store_a']);
  expect(storeKeysFor('ios', 'official', table)).toEqual([]);
  expect(storeKeysFor('harmony', 'agc', table)).toEqual([]);
});

it('[AC-F1-02zc#26] 默认商店表来源与 specs/app-stores.yaml 一致', () => {
  const table = parseYamlLite(
    readFileSync(new URL('../../../../specs/app-stores.yaml', import.meta.url), 'utf8'),
  ) as {
    stores: { key: string | null; platform: string; channels: string[] }[];
  };
  for (const [platform, channel] of [
    ['ios', 'appstore'],
    ['android', 'official'],
    ['android', 'huawei'],
    ['harmony', 'agc'],
  ]) {
    expect(storeKeysFor(platform!, channel!)).toEqual(
      table.stores
        .filter((row) => row.platform === platform && row.channels.includes(channel!))
        .flatMap((row) => (row.key === null ? [] : [row.key])),
    );
  }
});

it('[AC-F1-02zc#19] 非空商店表必须验证 confirmed_stores，包括无需实际确认的键', () => {
  expect(
    validateAdminAppVersionSave({ ...body, confirmed_stores: ['store_other'] }, ['store_a']),
  ).toEqual({ ok: false, fields: ['confirmed_stores'], store_table_empty: false });
});

it.each([
  [{ default_store: 'store_other' }, 'default_store'],
  [{ store_listings: [{ store: 'store_other', listed_version: null }] }, 'store_listings'],
] as const)('[AC-F1-02zc#20] 注入商店表限制 %j，错误字段 %s', (patch, field) => {
  expect(validateAdminAppVersionSave({ ...body, ...patch }, ['store_a'])).toEqual({
    ok: false,
    fields: [field],
    store_table_empty: false,
  });
});

it('[AC-F1-02zc#21] 空表只校格式、非空表合法键允许多余确认', () => {
  expect(validateAdminAppVersionSave({ ...body, confirmed_stores: ['store_other'] }, [])).toEqual({
    ok: true,
    store_table_empty: true,
  });
  expect(
    validateAdminAppVersionSave({ ...body, confirmed_stores: ['store_a'] }, ['store_a']),
  ).toEqual({ ok: true, store_table_empty: false });
});

it.each([
  'https://store.example.test/a',
  'market://details?id=demo',
  'appmarket://details?id=demo',
  'itms-apps://apps.example.test/a',
])('[AC-F1-02zc#22] 沿用 F1-02zb 商店 URL 白名单 %s', (store_url) => {
  expect(validateAdminAppVersionSave({ ...body, store_url }, ['store_a'])).toEqual({
    ok: true,
    store_table_empty: false,
  });
});
