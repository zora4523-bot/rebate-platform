import { expect, it } from 'vitest';
import {
  compareVersions,
  draftOf,
  editTargetOf,
  fieldNameOf,
  laggingStores,
  raisesMinimum,
  requestOf,
  type AppVersionRow,
} from './model.ts';

const row: AppVersionRow = {
  platform: 'android',
  channel: 'official',
  latest_version: '1.2.0',
  min_supported_version: '1.0.0',
  recommended_version: null,
  update_title: '标题',
  update_notes: '说明',
  store_url: 'https://stores.example.test/x',
  default_store: 'demo_a',
  store_listings: [
    { store: 'demo_a', listed_version: '0.9.0' },
    { store: 'demo_b', listed_version: '0.9.9' },
    { store: 'demo_c', listed_version: null },
    { store: 'demo_d', listed_version: '1.0.0' },
  ],
  row_version: 0,
  updated_at: '2026-10-22T03:45:00Z',
};

it('[AC-F1-10h-UNIT#1] 版本按数字逐段比较，格式不对时不比较', () => {
  expect(compareVersions('2.10.0', '2.9.0')).toBe(1);
  expect(compareVersions('10.0.0', '9.99.99')).toBe(1);
  expect(compareVersions('2.9.0', '2.9.0')).toBe(0);
  expect(compareVersions('0.0.0', '0.0.1')).toBe(-1);
  expect(compareVersions('2.9', '2.9.0')).toBeUndefined();
});

it('[AC-F1-10h-UNIT#2] 只有保存后更高（原来为空也算）才算提高最低版本', () => {
  expect(raisesMinimum('2.9.0', '2.10.0')).toBe(true);
  expect(raisesMinimum(null, '0.0.0')).toBe(true);
  expect(raisesMinimum(undefined, '1.0.0')).toBe(true);
  expect(raisesMinimum('2.10.0', '2.9.0')).toBe(false);
  expect(raisesMinimum('2.9.0', '2.9.0')).toBe(false);
  expect(raisesMinimum('2.9.0', null)).toBe(false);
  expect(raisesMinimum(null, null)).toBe(false);
});

it('[AC-F1-10h-UNIT#3] 整行请求体保留 null 语义与 row_version=0，新建时 expected_row_version=null', () => {
  const body = requestOf(draftOf(row), row);
  expect(body).toEqual({
    latest_version: '1.2.0',
    min_supported_version: '1.0.0',
    recommended_version: null,
    update_title: '标题',
    update_notes: '说明',
    store_url: 'https://stores.example.test/x',
    default_store: 'demo_a',
    store_listings: row.store_listings,
    confirmed_stores: [],
    expected_row_version: 0,
  });
  expect(requestOf(draftOf(row), undefined).expected_row_version).toBeNull();
});

it('[AC-F1-10h-UNIT#4] 落后商店不含默认商店、未上架与持平的商店', () => {
  const body = requestOf(draftOf(row), row);
  expect(laggingStores(body)).toEqual([{ store: 'demo_b', listed: '0.9.9' }]);
  expect(laggingStores({ ...body, min_supported_version: null })).toEqual([]);
});

it('[AC-F1-10h-UNIT#5] 编辑子页地址只认可编辑的端与契约里的渠道', () => {
  expect(editTargetOf('app-versions/ios/appstore')).toEqual({
    platform: 'ios',
    channel: 'appstore',
  });
  expect(editTargetOf('/app-versions/harmony/agc')).toEqual({
    platform: 'harmony',
    channel: 'agc',
  });
  expect(editTargetOf('app-versions/h5/official')).toBeUndefined();
  expect(editTargetOf('app-versions/android/unknown')).toBeUndefined();
  expect(editTargetOf('app-versions')).toBeUndefined();
});

it('[AC-F1-10h-UNIT#6] 20001 字段名取首段', () => {
  expect(fieldNameOf('store_listings[1].store')).toBe('store_listings');
  expect(fieldNameOf('confirmed_stores')).toBe('confirmed_stores');
  expect(fieldNameOf('default_store')).toBe('default_store');
  expect(fieldNameOf('path')).toBeUndefined();
});
