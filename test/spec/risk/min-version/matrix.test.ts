import { expect, it } from 'vitest';
import { HEADERS, PRINCIPAL, expectBlocked, fixture, request } from './kit.ts';

const versions = [
  { version: '2.10.2', blocked: true },
  { version: '2.10.3', blocked: false },
  { version: '2.10.4', blocked: false },
  { version: undefined, blocked: true },
  ...[
    '',
    '2.10',
    'v2.10.3',
    '02.10.3',
    '2.10.3-beta',
    '2.10.3+build',
    '-1.0.0',
    ' 2.10.3',
    'NaN',
  ].map((version) => ({ version, blocked: true })),
  { version: '2.9.99', blocked: true },
  { version: '2.11.0', blocked: false },
  { version: '3.0.0', blocked: false },
  { version: '10.0.0', blocked: false },
  { version: '999999999999999999999999.0.0', blocked: false },
];

for (const platform of ['ios', 'android', 'harmony']) {
  for (const config of ['configured', 'missing-row', 'null-minimum'] as const) {
    for (const { version, blocked } of versions) {
      it(`[AC-B1-03c#1] ${platform}/${config}/${String(version)}：按数值版本及当前配置判定`, async () => {
        // The reader deliberately collapses missing row and SQL NULL to null, as its contract does.
        const minimum = config === 'configured' ? '2.10.3' : null;
        const f = fixture(minimum);
        const input = request({
          headers: { ...HEADERS, 'x-platform': platform, 'x-app-version': version },
        });
        if (blocked && minimum !== null) await expectBlocked(() => f.check(input), minimum);
        else await expect(f.check(input)).resolves.toBeUndefined();
        expect(f.read).toHaveBeenCalledWith('couli', platform, 'app_store');
      });
    }
  }
}

for (const platform of ['h5', 'admin']) {
  it(`[AC-B1-03c#2] ${platform} 不因旧版本或缺版本被拦截`, async () => {
    const f = fixture();
    for (const version of ['0.0.0', 'invalid', undefined]) {
      await expect(
        f.check(
          request({ headers: { ...HEADERS, 'x-platform': platform, 'x-app-version': version } }),
        ),
      ).resolves.toBeUndefined();
    }
    expect(f.read).not.toHaveBeenCalled();
  });
}

it('[AC-B1-03c#3] app_id、端、渠道不串读；10405 携带该组合当前最低版本', async () => {
  const f = fixture();
  f.read.mockImplementation(async (app, platform, channel) => {
    if (app === 'other' && platform === 'android' && channel === 'vendor_store') return '4.5.6';
    if (app === 'couli' && platform === 'ios' && channel === 'app_store') return '2.10.3';
    return null;
  });
  await expectBlocked(() => f.check(request()), '2.10.3');
  await expectBlocked(
    () =>
      f.check(
        request({
          principal: { ...PRINCIPAL, app_id: 'other' },
          headers: {
            ...HEADERS,
            'x-app-id': 'other',
            'x-platform': 'android',
            'x-channel': 'vendor_store',
          },
        }),
      ),
    '4.5.6',
  );
  await expect(
    f.check(request({ headers: { ...HEADERS, 'x-channel': 'unconfigured' } })),
  ).resolves.toBeUndefined();
  f.read.mockResolvedValue('7.0.0');
  await expectBlocked(() => f.check(request()), '7.0.0');
  expect(f.read.mock.calls).toContainEqual(['other', 'android', 'vendor_store']);
});

it('[AC-B1-03c#4] 配置读取失败不能当作没有最低版本而放行', async () => {
  const f = fixture();
  const unavailable = new Error('minimum reader unavailable');
  f.read.mockRejectedValue(unavailable);
  await expect(f.check(request())).rejects.toBe(unavailable);
});
