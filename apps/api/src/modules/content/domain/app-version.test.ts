import { expect, it } from 'vitest';
import { buildAppVersionCheck, InvalidAppVersionError, type AppVersionRow } from './app-version.ts';

const ROW: AppVersionRow = {
  latest_version: '1.0.0',
  min_supported_version: '3.0.0',
  recommended_version: null,
  update_title: 'New version',
  update_notes: 'Line one\nLine two',
  store_url: 'market://details?id=app',
  default_store: 'default',
  store_listings: [],
};

it('[AC-F1-02e#1] preserves columns without comparing versions or replacing null', () => {
  expect(buildAppVersionCheck(ROW)).toEqual({
    latest_version: '1.0.0',
    min_supported_version: '3.0.0',
    recommended_version: null,
    update_title: 'New version',
    update_notes: 'Line one\nLine two',
    store_url: 'market://details?id=app',
    default_store: 'default',
    stores: [{ store: 'default', listed_version: null }],
  });
});

it('[AC-F1-02e#4] strips extra keys, preserves order, appends default and leaves the input intact', () => {
  const listings = [
    { store: 'z', listed_version: '1.2.3', download_url: 'https://example.test/app.apk' },
    { store: 'a' },
  ];
  const before = structuredClone(listings);
  expect(buildAppVersionCheck({ ...ROW, store_listings: listings }).stores).toEqual([
    { store: 'z', listed_version: '1.2.3' },
    { store: 'a', listed_version: null },
    { store: 'default', listed_version: null },
  ]);
  expect(listings).toEqual(before);
});

it('[AC-F1-02e#4] an existing default retains its position and version', () => {
  const listings = [
    { store: 'z', listed_version: null },
    { store: 'default', listed_version: '2.0.0' },
    { store: 'a', listed_version: null },
  ];
  expect(buildAppVersionCheck({ ...ROW, store_listings: listings }).stores).toEqual(listings);
});

it.each([
  null,
  {},
  [null],
  [[]],
  ['store'],
  [{ store: '' }],
  [{ store: 42 }],
  [{ store: 'a', listed_version: false }],
  [{ store: 'a', listed_version: '1.2' }],
  [{ store: 'a', listed_version: '01.2.3' }],
  [{ store: 'a', listed_version: '1.2.3-beta' }],
  [{ store: 'a' }, { store: 'a', listed_version: '1.0.0' }],
])('[AC-F1-02e#5] malformed listings reject the entire row: %j', (store_listings) => {
  expect(() => buildAppVersionCheck({ ...ROW, store_listings })).toThrow(
    new InvalidAppVersionError('store_listings'),
  );
});

it.each(['not a uri', '/relative', '//example.test/app'])(
  '[AC-F1-02e#5] relative and malformed addresses are rejected: %s',
  (store_url) => {
    expect(() => buildAppVersionCheck({ ...ROW, store_url })).toThrow(
      new InvalidAppVersionError('store_url'),
    );
  },
);

it('[AC-F1-02e#5] an empty default is invalid even when the listing array is empty', () => {
  expect(() => buildAppVersionCheck({ ...ROW, default_store: '' })).toThrow(
    new InvalidAppVersionError('default_store'),
  );
});
