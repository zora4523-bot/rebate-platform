// F1-02zzs §9.2#3–4 / §9.3#3: publishing sdk_list or collect_list writes no legal.* key and no
// configuration history, so /v1/config (first-launch consent and re-consent read its legal block)
// and GET /v1/agreements stay exactly as they were. The api entry's clock is moved past the 60 s
// content caches before every comparison, so equality cannot come from a cached answer.
import { expect, it } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  config,
  publicApp,
  publicConfig,
  publicList,
  publicRead,
  publishOk,
  setup,
  snapshot,
  storedPublic,
  success,
  useHarness,
  type AgreementsData,
  type PublicVersion,
} from './sdk-collect-api-kit.ts';

const h = useHarness(() => import('@couli/db/testing'));

const CACHE_PASSED_MS = 60_001;

it('[AC-F1-02zzs#13] 发布两类前后 config_items 与 config_item_versions 逐行不变，/v1/config 的 legal 与 ETag、/v1/agreements 不变', async () => {
  const f = await setup(h);
  const p = await publicApp(h);
  await config(h, f.appId, 'h5_release.stable', 'stable');
  await config(h, f.appId, 'kf', { url: 'https://kf.example.test/' });
  await publishOk(f, 'privacy');
  await publishOk(f, 'agreement');
  await publishOk(f, 'privacy', { min_version: 2, expected_version: 1 });

  const before = await snapshot(h, f.appId);
  expect(before.items.filter((row) => row.key.startsWith('legal.')).map((row) => row.key)).toEqual([
    'legal.agreement.min_version',
    'legal.agreement.version',
    'legal.privacy.min_version',
    'legal.privacy.version',
  ]);
  const configBefore = await publicConfig(p, f.appId);
  const configData = await success<Schema<'Config'>>(configBefore, 'config');
  expect(configData.legal).toMatchObject({
    privacy: { version: 2, min_version: 2 },
    agreement: { version: 1, min_version: 1 },
  });
  const listBefore = await success<AgreementsData>(await publicList(p, f.appId), 'agreements');
  expect(listBefore).toEqual({
    privacy: await storedPublic(h, f.appId, 'privacy', 2),
    agreement: await storedPublic(h, f.appId, 'agreement', 1),
  });

  for (const [type, version] of [
    ['sdk_list', 1],
    ['collect_list', 1],
    ['sdk_list', 2],
    ['collect_list', 2],
  ] as const) {
    expect(
      await publishOk(f, type, { min_version: version, expected_version: version - 1 }),
    ).toMatchObject({ type, version, min_version: version, requires_resign: false });
  }

  const after = await snapshot(h, f.appId);
  expect(after.items).toEqual(before.items);
  expect(after.versions).toEqual(before.versions);
  expect(after.agreements.filter((row) => row.type === 'sdk_list')).toHaveLength(2);
  expect(after.agreements.filter((row) => row.type === 'collect_list')).toHaveLength(2);

  p.clock.advanceMs(CACHE_PASSED_MS);
  const configAfter = await publicConfig(p, f.appId);
  expect(await success<Schema<'Config'>>(configAfter, 'config')).toEqual(configData);
  expect(configAfter.response.headers['etag']).toBe(configBefore.response.headers['etag']);
  const listAfter = await success<AgreementsData>(await publicList(p, f.appId), 'agreements');
  expect(listAfter).toEqual(listBefore);
  expect(Object.keys(listAfter).sort()).toEqual(['agreement', 'privacy']);

  // The notices themselves are readable, which shows the publishes above were not refused.
  for (const type of ['sdk_list', 'collect_list'] as const) {
    expect(await success<PublicVersion>(await publicRead(p, f.appId, type), 'version')).toEqual(
      await storedPublic(h, f.appId, type, 2),
    );
  }

  // A consent publish after the notices still moves its keys, and the list follows it.
  await publishOk(f, 'agreement', { min_version: 2, expected_version: 1 });
  const moved = await snapshot(h, f.appId);
  expect(
    moved.items
      .filter((row) => row.key.startsWith('legal.agreement.'))
      .map((row) => [row.key, row.value]),
  ).toEqual([
    ['legal.agreement.min_version', 2],
    ['legal.agreement.version', 2],
  ]);
  p.clock.advanceMs(CACHE_PASSED_MS);
  expect(await success<AgreementsData>(await publicList(p, f.appId), 'agreements')).toEqual({
    privacy: await storedPublic(h, f.appId, 'privacy', 2),
    agreement: await storedPublic(h, f.appId, 'agreement', 2),
  });
});
