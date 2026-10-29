// B1-28h: the server caches the hot list per (platform, channel, category, page) for
// rank.cache_ttl_seconds, default 600 (规划/01 F-PROD-13 ⑥; B1-28g registers the key). On a union
// failure an existing entry is read; without one the answer is 50304 without reason, never the
// product pool (F-PROD-13 ⑥, same as F-PROD-07; contracts/error-codes.yaml 50304).
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP,
  DEFAULT_TTL_SECONDS,
  PAGE_SIZE,
  TB_CHANNEL,
  TTL_KEY,
  candidate,
  channel,
  dataOf,
  fixture,
  rejection,
  series,
} from './kit.ts';

function unionCalls(f: ReturnType<typeof fixture>): number {
  return f.page.mock.calls.length + f.categories.mock.calls.length;
}

function titles(data: Awaited<ReturnType<ReturnType<typeof fixture>['run']>>) {
  return data.items.map((item) => [item.rank, item.product_card.title, item.sales_text]);
}

it('[AC-B1-28h#18] 缓存期内同一（平台、频道、类目、页码）再请求不再取联盟；名次、销量、类目与频道不变，卡片仍逐次组装并登记', async () => {
  const f = fixture({ cached: true });
  f.setCategories('taobao', TB_CHANNEL, [{ categoryId: 'synthetic-digital', name: '合成数码' }]);
  f.setPage('taobao', TB_CHANNEL, null, 1, [
    candidate('hit-a', { salesText: '1.2万' }),
    candidate('hit-b'),
  ]);

  const first = await f.run();
  const calls = unionCalls(f);
  expect(calls).toBeGreaterThan(0);
  f.clock.advanceMs(60_000);
  const second = await f.run();

  expect(unionCalls(f)).toBe(calls);
  expect(titles(second)).toEqual(titles(first));
  expect(second.categories).toEqual(first.categories);
  expect(second.channel).toBe(first.channel);
  expect(f.register).toHaveBeenCalledTimes(4);
});

it('[AC-B1-28h#19] rank.cache_ttl_seconds 未配置时按 600 秒：599 秒仍命中，601 秒重新取联盟并换成新数据', async () => {
  const f = fixture({ cached: true });
  f.setPage('taobao', TB_CHANNEL, null, 1, [candidate('old')]);
  await f.run();
  const calls = f.page.mock.calls.length;

  f.setPage('taobao', TB_CHANNEL, null, 1, [candidate('new')]);
  f.clock.advanceMs((DEFAULT_TTL_SECONDS - 1) * 1000);
  expect(titles(await f.run())).toEqual([[1, 'synthetic-old', null]]);
  expect(f.page.mock.calls.length).toBe(calls);

  f.clock.advanceMs(2_000);
  expect(titles(await f.run())).toEqual([[1, 'synthetic-new', null]]);
  expect(f.page.mock.calls.length).toBe(calls + 1);
});

it('[AC-B1-28h#20] 缓存时长按本 app 的 rank.cache_ttl_seconds：配 120 时 119 秒命中、121 秒重新取', async () => {
  const f = fixture({ cached: true });
  f.settings.set(TTL_KEY, 120);
  f.setPage('taobao', TB_CHANNEL, null, 1, [candidate('old')]);
  await f.run();
  const calls = f.page.mock.calls.length;

  f.setPage('taobao', TB_CHANNEL, null, 1, [candidate('new')]);
  f.clock.advanceMs(119_000);
  expect(titles(await f.run())).toEqual([[1, 'synthetic-old', null]]);
  f.clock.advanceMs(2_000);
  expect(titles(await f.run())).toEqual([[1, 'synthetic-new', null]]);
  expect(f.page.mock.calls.length).toBe(calls + 1);
  expect(f.configValue.mock.calls).toContainEqual([APP, TTL_KEY]);
});

it('[AC-B1-28h#21] 缓存按（平台、频道、类目、页码）分开：任一维度不同都单独取一次，各自再请求都命中', async () => {
  const f = fixture({ cached: true });
  f.setChannels([channel('taobao', TB_CHANNEL), channel('jd', 'synthetic_jd_sales')]);
  f.setCategories('taobao', TB_CHANNEL, [{ categoryId: 'synthetic-digital', name: '合成数码' }]);
  f.setPage('taobao', TB_CHANNEL, null, 1, series('whole', PAGE_SIZE, 1), true);
  f.setPage('taobao', TB_CHANNEL, null, 2, series('whole', 1, 21), false);
  f.setPage('taobao', TB_CHANNEL, 'synthetic-digital', 1, [candidate('digital')]);
  f.setPage('jd', 'synthetic_jd_sales', null, 1, [candidate('jd', { platform: 'jd' })]);

  const whole = await f.run();
  const pageTwo = await f.run({ cursor: whole.next_cursor! });
  const digital = await f.run({ category: 'synthetic-digital' });
  const jd = await f.run({ platform: 'jd' });
  const pageRequests = f.page.mock.calls.map(([input]) => [
    input.platform,
    input.channelId,
    input.categoryId,
    input.pageNo,
  ]);
  expect(pageRequests).toEqual([
    ['taobao', TB_CHANNEL, null, 1],
    ['taobao', TB_CHANNEL, null, 2],
    ['taobao', TB_CHANNEL, 'synthetic-digital', 1],
    ['jd', 'synthetic_jd_sales', null, 1],
  ]);

  f.clock.advanceMs(30_000);
  expect(titles(await f.run())).toEqual(titles(whole));
  expect(titles(await f.run({ cursor: whole.next_cursor! }))).toEqual(titles(pageTwo));
  expect(titles(await f.run({ category: 'synthetic-digital' }))).toEqual(titles(digital));
  expect(titles(await f.run({ platform: 'jd' }))).toEqual(titles(jd));
  expect(f.page.mock.calls.length).toBe(4);
});

it('[AC-B1-28h#22] 联盟故障时有缓存读缓存（已过缓存时长的也读），按原名次与销量下发', async () => {
  const f = fixture({ cached: true });
  f.setCategories('taobao', TB_CHANNEL, [{ categoryId: 'synthetic-digital', name: '合成数码' }]);
  f.setPage('taobao', TB_CHANNEL, null, 1, [
    candidate('kept-a', { salesText: '5000+' }),
    candidate('kept-b'),
  ]);
  const first = await f.run();

  f.clock.advanceMs((DEFAULT_TTL_SECONDS + 60) * 1000);
  f.fail(new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao'));
  const served = await f.run();

  expect(titles(served)).toEqual(titles(first));
  expect(served.categories).toEqual(first.categories);
  expect(served.channel).toBe(TB_CHANNEL);
});

it('[AC-B1-28h#23] 联盟故障（不可用、限流）且没有缓存 → 50304、data 不带 reason（可重试），不下发任何卡片', async () => {
  for (const failure of [
    new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao'),
    new UnionError('rate_limited', 'synthetic rate limited', 'taobao'),
  ]) {
    for (const cached of [true, false]) {
      const f = fixture({ cached });
      f.setPage('taobao', TB_CHANNEL, null, 1, [candidate('never')]);
      f.fail(failure);

      const error = await rejection(() => f.run());

      expect(error, `${failure.code} cached=${cached}`).toMatchObject({ code: 50304 });
      expect(dataOf(error)?.['reason']).toBeUndefined();
      expect(dataOf(error)?.['platform']).toBe('taobao');
      expect(f.register).not.toHaveBeenCalled();
    }
  }
});
