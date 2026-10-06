import { expect, it, vi } from 'vitest';
import { sessionScope } from '../../../../apps/api/src/modules/identity/application/session-scope.ts';
import { compareClientVersions } from '../../../../apps/api/src/modules/platform/client-version/index.ts';

for (const [client, minimum, result] of [
  ['1.9.9', '1.10.0', -1],
  ['1.10.0', '1.9.9', 1],
  ['2.0.0', '1.99.99', 1],
  ['1.2.9', '1.2.10', -1],
  ['1.2.10', '1.2.10', 0],
  [undefined, '1.0.0', null],
  ['', '1.0.0', null],
  ['broken', '1.0.0', null],
  ['1.2', '1.0.0', null],
] as const) {
  it(`[BR-ID-01] 版本比较 ${String(client)} / ${minimum} → ${String(result)}`, () => {
    expect(compareClientVersions(client, minimum)).toBe(result);
  });
}

for (const platform of ['ios', 'android', 'harmony'] as const) {
  it(`[BR-ID-01][BR-ID-07] ${platform} 按本次请求版本与App渠道判定，每次签发重新计算`, async () => {
    const minSupportedVersion = vi.fn(async () => '1.10.0');
    const versions = { minSupportedVersion };
    for (const [version, scope] of [
      ['1.9.0', 'deletion_only'],
      ['1.10.0', 'full'],
      ['2.0.0', 'full'],
      [undefined, 'deletion_only'],
      ['bad', 'deletion_only'],
    ] as const) {
      expect(
        await sessionScope(
          {
            appId: 'couli',
            platform,
            channel: 'store',
            ...(version === undefined ? {} : { version }),
          },
          versions,
        ),
      ).toBe(scope);
      expect(minSupportedVersion).toHaveBeenLastCalledWith('couli', platform, 'store');
    }
    expect(minSupportedVersion).toHaveBeenCalledTimes(5);
  }, 30_000);
}

it('[BR-ID-01] h5、admin、缺渠道或无最低配置均full，不把缺渠道替成某个默认渠道', async () => {
  const minSupportedVersion = vi.fn(async () => null);
  for (const platform of ['h5', 'admin'] as const) {
    expect(
      await sessionScope(
        { appId: 'couli', platform, channel: 'store', version: 'bad' },
        { minSupportedVersion },
      ),
    ).toBe('full');
  }
  expect(
    await sessionScope(
      { appId: 'couli', platform: 'ios', version: 'bad' },
      { minSupportedVersion },
    ),
  ).toBe('full');
  expect(minSupportedVersion).not.toHaveBeenCalled();
  expect(
    await sessionScope(
      { appId: 'other', platform: 'android', channel: 'other-store', version: 'bad' },
      { minSupportedVersion },
    ),
  ).toBe('full');
  expect(minSupportedVersion).toHaveBeenCalledWith('other', 'android', 'other-store');
});

it('[BR-ID-01] 版本查询失败不能伪装成没有配置而签发full', async () => {
  const failure = new Error('version-store-unavailable');
  await expect(
    sessionScope(
      { appId: 'couli', platform: 'ios', channel: 'store', version: '2.0.0' },
      {
        minSupportedVersion: async () => {
          throw failure;
        },
      },
    ),
  ).rejects.toBe(failure);
});
