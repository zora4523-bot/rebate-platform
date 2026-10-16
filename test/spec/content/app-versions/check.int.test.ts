// F1-02e rule tests: GET /v1/app-versions/check (see kit.ts for sources and decisions).
// Red on main: the route is not registered yet (404), allowed until F1-02c + F1-02e land.
import { expect, it } from 'vitest';
import {
  CACHE_MS,
  changeLatest,
  check,
  expected,
  freshAppId,
  harness,
  headers,
  ok,
  rejected,
  moveAway,
  row,
  seed,
} from './kit.ts';

// Only this *.int.test.ts loads the testcontainers entry; the kit receives it as a loader.
const h = harness(() => import('@couli/db/testing'));

it('[AC-F1-02e#1] every column of the (app, platform, channel) row is returned verbatim and passes the contract', async () => {
  const appId = freshAppId();
  const value = row(appId);
  await seed(h.db, value);

  const data = await ok(await check(h, headers(appId)));

  expect(data).toEqual(expected(value, value.store_listings as never));
  // latest, minimum and recommended are three distinct columns; none stands in for another.
  expect(data.min_supported_version).toBe('1.2.3');
  expect(data.recommended_version).toBe('2.3.4');
  expect(data.latest_version).toBe('3.4.5');
  expect(Object.keys(data).sort()).toEqual([
    'default_store',
    'latest_version',
    'min_supported_version',
    'recommended_version',
    'store_url',
    'stores',
    'update_notes',
    'update_title',
  ]);
});

it('[AC-F1-02e#1] null minimum and recommended versions are returned as null, not "" nor latest', async () => {
  const appId = freshAppId();
  const value = row(appId, { min_supported_version: null, recommended_version: null });
  await seed(h.db, value);

  const data = await ok(await check(h, headers(appId)));

  expect(data.min_supported_version).toBeNull();
  expect(data.recommended_version).toBeNull();
  expect(data).toEqual(expected(value, value.store_listings as never));
});

it.each([
  ['ios', 'appstore'],
  ['harmony', 'agc'],
  ['h5', 'official'],
  ['admin', 'official'],
] as const)(
  '[AC-F1-02e#1] platform %s / channel %s is looked up like any other (no platform gating)',
  async (platform, channel) => {
    const appId = freshAppId();
    const value = row(appId, {
      platform,
      channel,
      default_store: 'appstore',
      store_listings: [{ store: 'appstore', listed_version: '3.4.5' }],
    });
    await seed(h.db, value);

    const data = await ok(
      await check(h, headers(appId, { 'x-platform': platform, 'x-channel': channel })),
    );

    expect(data).toEqual(expected(value, [{ store: 'appstore', listed_version: '3.4.5' }]));
  },
);

it('[AC-F1-02e#2] the exact channel row is chosen; no fallback to another channel, platform or app', async () => {
  const appId = freshAppId();
  const official = row(appId, { channel: 'official', latest_version: '5.0.0' });
  const huawei = row(appId, {
    channel: 'huawei',
    latest_version: '5.1.0',
    min_supported_version: '4.0.0',
    recommended_version: '5.0.1',
    update_title: '华为渠道',
    store_url: 'https://store.example.test/huawei',
  });
  // Seeded official first so "first row of the platform" picks the wrong one.
  await seed(h.db, official);
  await seed(h.db, huawei);

  const fromHuawei = await ok(await check(h, headers(appId, { 'x-channel': 'huawei' })));
  expect(fromHuawei).toEqual(expected(huawei, huawei.store_listings as never));
  const fromOfficial = await ok(await check(h, headers(appId, { 'x-channel': 'official' })));
  expect(fromOfficial).toEqual(expected(official, official.store_listings as never));

  // (android, agc) has no row -> 50001, never the official/huawei row.
  await rejected(await check(h, headers(appId, { 'x-channel': 'agc' })), 50001);
  // Without X-Channel no row is selected (official is not a default).
  await rejected(await check(h, headers(appId, { 'x-channel': undefined })), 50001);
  // Same channel on another platform has no row.
  await rejected(
    await check(h, headers(appId, { 'x-platform': 'harmony', 'x-channel': 'huawei' })),
    50001,
  );
});

it('[AC-F1-02e#2] a row that exists only for another app is never returned', async () => {
  const owner = freshAppId();
  await seed(h.db, row(owner));
  const other = freshAppId();

  await rejected(await check(h, headers(other)), 50001);
  await rejected(await check(h, headers(other, { 'x-channel': undefined })), 50001);
  // The owner still gets its own row.
  await ok(await check(h, headers(owner)));
});

it('[AC-F1-02e#3] X-App-Version below minimum, equal to minimum and above latest yields the same 200 body', async () => {
  const appId = freshAppId();
  const value = row(appId, { min_supported_version: '2.0.0', latest_version: '3.0.0' });
  await seed(h.db, value);

  const bodies = [];
  for (const version of ['1.9.9', '2.0.0', '9.0.0']) {
    const response = await check(h, headers(appId, { 'x-app-version': version }));
    const data = await ok(response);
    expect(data).toEqual(expected(value, value.store_listings as never));
    const body = response.json<Record<string, unknown>>();
    expect(body).toHaveProperty('trace_id');
    bodies.push({ ...body, trace_id: null });
  }
  expect(bodies[0]).not.toHaveProperty('code', 10405);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[2]).toEqual(bodies[0]);
});

it('[AC-F1-02e#4] stores keep the written order and are not sorted or reordered by default_store', async () => {
  const appId = freshAppId();
  const listings = [
    { store: 'xiaomi', listed_version: '3.4.1' },
    { store: 'huawei', listed_version: null },
    { store: 'oppo', listed_version: '3.0.0' },
  ];
  const value = row(appId, { default_store: 'huawei', store_listings: listings });
  await seed(h.db, value);

  const data = await ok(await check(h, headers(appId)));

  expect(data.stores).toEqual(listings);
});

it('[AC-F1-02e#4] default_store missing from the listings is appended last with listed_version null', async () => {
  const appId = freshAppId();
  const listings = [
    { store: 'xiaomi', listed_version: '3.4.1' },
    { store: 'oppo', listed_version: null },
  ];
  const value = row(appId, { default_store: 'vivo', store_listings: listings });
  await seed(h.db, value);

  const data = await ok(await check(h, headers(appId)));

  expect(data.stores).toEqual([...listings, { store: 'vivo', listed_version: null }]);
  expect(data.default_store).toBe('vivo');
});

it('[AC-F1-02e#4] empty listings produce exactly the default_store entry', async () => {
  const appId = freshAppId();
  const value = row(appId, { default_store: 'appstore', store_listings: [] });
  await seed(h.db, value);

  const data = await ok(await check(h, headers(appId)));

  expect(data.stores).toEqual([{ store: 'appstore', listed_version: null }]);
});

it('[AC-F1-02e#4] extra element keys are dropped and a missing listed_version becomes null', async () => {
  const appId = freshAppId();
  const value = row(appId, {
    default_store: 'huawei',
    store_listings: [
      { store: 'huawei', listed_version: '3.4.0', download_url: 'https://cdn.example.test/a.apk' },
      { store: 'xiaomi' },
    ],
  });
  await seed(h.db, value);

  const response = await check(h, headers(appId));
  const data = await ok(response);

  expect(data.stores).toEqual([
    { store: 'huawei', listed_version: '3.4.0' },
    { store: 'xiaomi', listed_version: null },
  ]);
  expect(JSON.stringify(response.json())).not.toContain('cdn.example.test');
});

it.each([
  [
    'listed_version is not SemVer',
    { store_listings: [{ store: 'huawei', listed_version: '1.2' }] },
  ],
  ['store is empty', { store_listings: [{ store: '', listed_version: null }] }],
  [
    'store appears twice',
    {
      store_listings: [
        { store: 'huawei', listed_version: '3.4.0' },
        { store: 'huawei', listed_version: null },
      ],
    },
  ],
  ['an element is not an object', { store_listings: ['huawei'] }],
  ['store_url is not a URI', { store_url: 'not a uri' }],
  ['default_store is empty', { default_store: '', store_listings: [] }],
])('[AC-F1-02e#5] a dirty row (%s) is rejected as a whole with 50001', async (_case, patch) => {
  const appId = freshAppId();
  await seed(h.db, row(appId, patch));

  await rejected(await check(h, headers(appId)), 50001);
});

it('[AC-F1-02e#5] a non-http absolute URI such as market:// is a valid store_url', async () => {
  const appId = freshAppId();
  const value = row(appId, { store_url: 'market://details?id=x' });
  await seed(h.db, value);

  const data = await ok(await check(h, headers(appId)));

  expect(data.store_url).toBe('market://details?id=x');
  expect(data).toEqual(expected(value, value.store_listings as never));
});

it('[AC-F1-02e#6] missing X-Device-Id, missing X-Platform or an unknown X-Channel is 400 / 20001', async () => {
  const appId = freshAppId();
  await seed(h.db, row(appId));

  await rejected(await check(h, headers(appId, { 'x-device-id': undefined })), 20001);
  await rejected(await check(h, headers(appId, { 'x-platform': undefined })), 20001);
  await rejected(await check(h, headers(appId, { 'x-channel': 'xiaomi' })), 20001);
});

it('[AC-F1-02e#6] a well-formed but never-registered X-Device-Id is accepted (200)', async () => {
  const appId = freshAppId();
  const value = row(appId);
  await seed(h.db, value);

  const data = await ok(
    await check(h, headers(appId, { 'x-device-id': '019a0000-0000-7000-8000-00000000f102' })),
  );

  expect(data).toEqual(expected(value, value.store_listings as never));
});

it('[AC-F1-02e#7] a changed row is served from the 60 s cache until the injected clock reaches the TTL', async () => {
  const appId = freshAppId();
  const value = row(appId, { latest_version: '3.4.5' });
  await seed(h.db, value);

  expect((await ok(await check(h, headers(appId)))).latest_version).toBe('3.4.5');
  await changeLatest(h.db, value, '3.5.0');
  expect((await ok(await check(h, headers(appId)))).latest_version).toBe('3.4.5');
  h.clock.advanceMs(CACHE_MS - 1);
  expect((await ok(await check(h, headers(appId)))).latest_version).toBe('3.4.5');
  h.clock.advanceMs(1);
  expect((await ok(await check(h, headers(appId)))).latest_version).toBe('3.5.0');
});

it('[AC-F1-02e#7] after the row leaves its channel, the cached row expires and the check returns 50001', async () => {
  const appId = freshAppId();
  const value = row(appId);
  await seed(h.db, value);

  await ok(await check(h, headers(appId)));
  await moveAway(h.db, value, 'agc');
  // Within the TTL the cached row is still served.
  h.clock.advanceMs(CACHE_MS - 1);
  await ok(await check(h, headers(appId)));
  h.clock.advanceMs(1);

  await rejected(await check(h, headers(appId)), 50001);
  // The row itself still exists, now under agc (the 50001 is not a failed fixture write).
  await ok(await check(h, headers(appId, { 'x-channel': 'agc' })));
});

it('[AC-F1-02e#8] no Authorization header is needed and no download address field is returned', async () => {
  const appId = freshAppId();
  const value = row(appId);
  await seed(h.db, value);
  const request = headers(appId);
  expect(request).not.toHaveProperty('authorization');

  const response = await check(h, request);
  const data = await ok(response);

  expect(data).toEqual(expected(value, value.store_listings as never));
  for (const key of ['download_url', 'apk_url', 'url', 'force_update', 'need_update']) {
    expect(data).not.toHaveProperty(key);
  }
});
