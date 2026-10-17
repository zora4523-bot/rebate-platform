import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { pickPageVersion } from '../../../../apps/api/src/modules/content/domain/pages/select/index.ts';

// F1-09b §9.2 R2/R3: independent oracle, never import the implementation's h5Bucket.
function bucket(appId: string, deviceId: string): number {
  return Number(
    createHash('sha256').update(`${appId}:${deviceId}`, 'utf8').digest().readBigUInt64BE(0) %
      10_000n,
  );
}

function findDevice(predicate: (deviceId: string) => boolean): string {
  for (let index = 0; index < 300_000; index += 1) {
    const deviceId = `pages_device_${index}`;
    if (predicate(deviceId)) return deviceId;
  }
  expect.fail('synthetic device search exhausted');
}

const appId = 'pages_select';

it.each([
  [3699, 23],
  [3700, 11],
])('[AC-F1-09b#1] bucket %i at the 37 percent boundary selects version %i', (target, expected) => {
  const deviceId = findDevice((id) => bucket(appId, id) === target);
  expect(bucket(appId, deviceId)).toBe(target);
  expect(
    pickPageVersion({
      appId,
      deviceId,
      page: { currentVersion: 11, grayVersion: 23, grayPercent: 37 },
    }),
  ).toBe(expected);
});

it('[AC-F1-09b#2] zero percent excludes even bucket zero', () => {
  const deviceId = findDevice((id) => bucket(appId, id) === 0);
  expect(
    pickPageVersion({
      appId,
      deviceId,
      page: { currentVersion: 11, grayVersion: 23, grayPercent: 0 },
    }),
  ).toBe(11);
});

it('[AC-F1-09b#3] 100 percent includes the last bucket', () => {
  const deviceId = findDevice((id) => bucket(appId, id) === 9999);
  expect(
    pickPageVersion({
      appId,
      deviceId,
      page: { currentVersion: 11, grayVersion: 23, grayPercent: 100 },
    }),
  ).toBe(23);
});

it.each([null, ''])('[AC-F1-09b#4] absent device %j always gets current version', (deviceId) => {
  // Ensure hashing an empty ID would enter gray, so the missing-ID branch is observable.
  const anonymousAppId = ['pages_anon_a', 'pages_anon_b', 'pages_anon_c'].find(
    (id) => bucket(id, '') < 9900,
  );
  expect(anonymousAppId).toBeDefined();
  for (const grayPercent of [99, 100]) {
    expect(
      pickPageVersion({
        appId: anonymousAppId!,
        deviceId,
        page: { currentVersion: 11, grayVersion: 23, grayPercent },
      }),
    ).toBe(11);
  }
});

it.each([0, 37, 100])(
  '[AC-F1-09b#5] missing gray version falls back at %i percent',
  (grayPercent) => {
    expect(
      pickPageVersion({
        appId,
        deviceId: 'pages_device',
        page: { currentVersion: 11, grayVersion: null, grayPercent },
      }),
    ).toBe(11);
  },
);

it('[AC-F1-09b#6] stable per-device choice uses appId as the hash namespace', () => {
  const otherAppId = 'pages_other';
  const deviceId = findDevice((id) => bucket(appId, id) < 3700 && bucket(otherAppId, id) >= 3700);
  const page = Object.freeze({ currentVersion: 11, grayVersion: 23, grayPercent: 37 });
  for (let repeat = 0; repeat < 5; repeat += 1) {
    expect(pickPageVersion({ appId, deviceId, page })).toBe(23);
    expect(pickPageVersion({ appId: otherAppId, deviceId, page })).toBe(11);
  }
  expect(page).toEqual({ currentVersion: 11, grayVersion: 23, grayPercent: 37 });
});

it.each([
  { deviceId: null, grayVersion: 23, grayPercent: 100, expected: null },
  { deviceId: '', grayVersion: 23, grayPercent: 100, expected: null },
  { deviceId: 'pages_device', grayVersion: 23, grayPercent: 0, expected: null },
  { deviceId: 'pages_device', grayVersion: null, grayPercent: 100, expected: null },
  { deviceId: 'pages_device', grayVersion: 23, grayPercent: 100, expected: 23 },
])(
  '[AC-F1-09b#7] missing current version: %j',
  ({ deviceId, grayVersion, grayPercent, expected }) => {
    expect(
      pickPageVersion({
        appId,
        deviceId,
        page: { currentVersion: null, grayVersion, grayPercent },
      }),
    ).toBe(expected);
  },
);

it('[AC-F1-09b#8] missing current version also returns null outside a partial rollout', () => {
  const deviceId = findDevice((id) => bucket(appId, id) === 3700);
  expect(
    pickPageVersion({
      appId,
      deviceId,
      page: { currentVersion: null, grayVersion: 23, grayPercent: 37 },
    }),
  ).toBeNull();
});
