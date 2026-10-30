// B1-28j: the production hot list upstream reads a channel's categories through union's ranking
// port (adapter channelCategories), in the adapter's order and content as is; the CallCtx is the
// caller's app with purpose online and a request id, as search-wiring builds it.
import { expect, it } from 'vitest';
import type { ChannelRankingCategory } from '../../../../apps/api/src/modules/union/index.ts';
import { APP, JD_CHANNEL, PDD_CHANNEL, TB_CHANNEL, fixture, hotRank } from './kit.ts';

const LIST: readonly ChannelRankingCategory[] = [
  { categoryId: 'synthetic-cat-z', name: '合成类目 Z' },
  { categoryId: 'synthetic-cat-a', name: '合成类目 A' },
  { categoryId: 'synthetic-cat-m', name: ' 合成类目 M ' },
];

it('[AC-B1-28j#1] categories 经该平台 adapter 的 channelCategories({ channelId }) 取，顺序与内容原样，不调 channelRanking', async () => {
  const f = fixture();
  f.fake('taobao').setCategories(LIST);
  const upstream = f.upstream();

  const result = await upstream.categories({
    appId: APP,
    platform: 'taobao',
    channelId: TB_CHANNEL,
  });

  expect(result).toEqual(LIST);
  const calls = f.fake('taobao').categoryCalls;
  expect(calls).toHaveLength(1);
  expect(calls[0]?.req).toEqual({ channelId: TB_CHANNEL });
  expect(f.fake('taobao').rankingCalls).toHaveLength(0);
  expect(f.fake('jd').channelCalls() + f.fake('pdd').channelCalls()).toBe(0);
  expect(f.lookups).toContain('taobao');
});

it('[AC-B1-28j#2] categories 的 CallCtx：appId 为调用方的 app，purpose=online，每次调用带非空 requestId', async () => {
  const f = fixture();
  f.fake('taobao').setCategories(LIST);
  const upstream = f.upstream();

  await upstream.categories({ appId: APP, platform: 'taobao', channelId: TB_CHANNEL });
  await upstream.categories({
    appId: 'synthetic_other_app',
    platform: 'taobao',
    channelId: TB_CHANNEL,
  });

  const contexts = f.fake('taobao').categoryCalls.map((call) => call.ctx);
  expect(contexts).toHaveLength(2);
  expect(contexts[0]).toMatchObject({ appId: APP, purpose: 'online' });
  expect(contexts[1]).toMatchObject({ appId: 'synthetic_other_app', purpose: 'online' });
  for (const ctx of contexts) {
    expect(typeof ctx.requestId).toBe('string');
    expect(ctx.requestId).not.toBe('');
  }
});

it('[AC-B1-28j#3] 京东、拼多多的 categories 各走自己平台的 adapter 与白名单频道', async () => {
  const f = fixture();
  f.fake('jd').setCategories([{ categoryId: 'synthetic-jd-cat', name: '合成京东类目' }]);
  f.fake('pdd').setCategories([{ categoryId: 'synthetic-pdd-cat', name: '合成拼多多类目' }]);
  const upstream = f.upstream();

  const jd = await upstream.categories({ appId: APP, platform: 'jd', channelId: JD_CHANNEL });
  const pdd = await upstream.categories({ appId: APP, platform: 'pdd', channelId: PDD_CHANNEL });

  expect(jd).toEqual([{ categoryId: 'synthetic-jd-cat', name: '合成京东类目' }]);
  expect(pdd).toEqual([{ categoryId: 'synthetic-pdd-cat', name: '合成拼多多类目' }]);
  expect(f.fake('jd').categoryCalls.map((call) => call.req)).toEqual([{ channelId: JD_CHANNEL }]);
  expect(f.fake('pdd').categoryCalls.map((call) => call.req)).toEqual([{ channelId: PDD_CHANNEL }]);
  expect(f.fake('taobao').channelCalls()).toBe(0);
});

it('[AC-B1-28j#4] 经 getHotRank：接口 categories 即 adapter 给的类目，顺序不变', async () => {
  const f = fixture();
  f.fake('taobao').setCategories(LIST);
  const run = hotRank(f);

  const data = await run();

  expect(data.channel).toBe(TB_CHANNEL);
  expect(data.categories).toEqual(
    LIST.map((entry) => ({ category_id: entry.categoryId, name: entry.name })),
  );
});
