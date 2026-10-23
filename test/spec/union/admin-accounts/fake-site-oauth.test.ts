// B1-22d / BR-ID-24 ③, SPEC_REF 48e55e6: the admin entry's local/test station-owner OAuth fake,
// whose convention the HTTP rule tests of this directory rely on. No platform is called.
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createFakeSiteOAuth } from '../../../../apps/api/src/modules/union/infra/fake-site-oauth.ts';

const NOW = '2026-10-09T02:00:00.000Z';
const DAY_MS = 86_400_000;
const okCode = (label: string) => `fake-site:ok:${label}`;
const daysCode = (days: number, label: string) => `fake-site:days:${days}:${label}`;
const fakeAccess = (label: string) => `fake-site-access:${label}`;
const fakeRefresh = (label: string) => `fake-site-refresh:${label}`;
const PLATFORMS = ['taobao', 'jd', 'pdd'] as const;

it('[B1-22d][BR-ID-24] 每个已登记平台都有假授权；auth_url 为 https 且原样带回 state', async () => {
  const providers = createFakeSiteOAuth('test', new FixedClock(NOW));
  for (const platform of PLATFORMS) {
    const provider = providers[platform];
    expect(provider, platform).toBeDefined();
    const state = `state-${platform}-AbC_-09`;
    const url = new URL(
      await provider!.authorizeUrl({
        appId: 'couli',
        unionAccountId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a01',
        state,
        expiresAt: new Date('2026-10-09T02:10:00.000Z'),
      }),
    );
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('site-oauth.example.test');
    expect(url.searchParams.get('state')).toBe(state);
  }
});

it('[B1-22d][BR-ID-24] fake-site:ok 换出固定令牌、不给到期；fake-site:days 按时钟加天数', async () => {
  const clock = new FixedClock(NOW);
  const provider = createFakeSiteOAuth('local', clock).taobao!;
  const input = { appId: 'couli', unionAccountId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a01' };
  await expect(provider.exchange({ ...input, code: okCode('alpha') })).resolves.toEqual({
    accessToken: fakeAccess('alpha'),
    refreshToken: fakeRefresh('alpha'),
    expiresAt: null,
  });
  const days = await provider.exchange({ ...input, code: daysCode(120, 'beta') });
  expect(days.accessToken).toBe(fakeAccess('beta'));
  expect(days.refreshToken).toBe(fakeRefresh('beta'));
  expect(days.expiresAt?.getTime()).toBe(new Date(NOW).getTime() + 120 * DAY_MS);
  clock.advanceMs(DAY_MS);
  const next = await provider.exchange({ ...input, code: daysCode(1, 'gamma') });
  expect(next.expiresAt?.getTime()).toBe(new Date(NOW).getTime() + 2 * DAY_MS);
});

it('[B1-22d][BR-ID-24] 其余授权码交换失败，错误文本带上授权码（用来检验不外泄）', async () => {
  const provider = createFakeSiteOAuth('test', new FixedClock(NOW)).jd!;
  const input = { appId: 'couli', unionAccountId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a01' };
  for (const code of ['fixture-declined-grant', 'fake-site:days:0:x', 'fake-site:nope']) {
    await expect(provider.exchange({ ...input, code })).rejects.toThrow(code);
  }
});

it('[B1-22d][BR-ID-24] 假授权只在 local / test 装配', () => {
  const clock = new FixedClock(NOW);
  expect(Object.keys(createFakeSiteOAuth('test', clock)).sort()).toEqual(['jd', 'pdd', 'taobao']);
  for (const appEnv of ['staging', 'prod']) {
    expect(() => createFakeSiteOAuth(appEnv, clock)).toThrow();
    expect(() => createFakeSiteOAuth(appEnv, clock)).not.toThrow(/NotImplemented/);
  }
});
