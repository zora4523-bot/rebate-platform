// B1-05n: what the fallback asks the union for. A search without results reads the selected
// whitelisted channel through union's ranking port, first page, as many entries as the use case
// wants, whole list; the general material feed is never read in its place (BR-TEXT-17 细则「联盟物料
// 频道」: its ranking must not depend on commission, which only the whitelist vouches for).
import { afterEach, expect, it, vi } from 'vitest';
import {
  APP,
  FALLBACK_LIMIT,
  JD_CHANNEL,
  PDD_CHANNEL,
  TB_CHANNEL,
  WHITELIST,
  fallbackSearch,
  feedRequest,
  fixture,
  jdItem,
  pddItem,
  position,
  tbItem,
  useCaseWhitelist,
} from './kit.ts';

afterEach(() => vi.restoreAllMocks());

it('[AC-B1-05n#1][BR-TEXT-17] 搜索无结果走到兜底：channelRanking 恰收到一次 { channelId, categoryId: null, pageNo: 1, pageSize: 10 }，adapter.materialFeed 未被调用', async () => {
  useCaseWhitelist(WHITELIST);
  const f = fixture();
  f.fake('taobao').setPage({ items: [position(tbItem('a', 1), '1')], hasMore: false });

  await fallbackSearch(f).run();

  expect(f.fake('taobao').rankingCalls.map((call) => call.req)).toEqual([
    { channelId: TB_CHANNEL, categoryId: null, pageNo: 1, pageSize: FALLBACK_LIMIT },
  ]);
  expect(f.fake('taobao').feedCalls()).toBe(0);
});

it('[AC-B1-05n#2] 三个平台各走自己的白名单频道与 adapter，别的平台不被调用', async () => {
  const cases = [
    {
      code: 'taobao',
      channelId: TB_CHANNEL,
      entries: [position(tbItem('b', 2), '2'), position(tbItem('a', 1), '1')],
      keys: ['tb:2', 'tb:1'],
    },
    {
      code: 'jd',
      channelId: JD_CHANNEL,
      entries: [position(jdItem('b', 2), '2'), position(jdItem('a', 1), '1')],
      keys: ['jd:i_2', 'jd:i_1'],
    },
    {
      code: 'pdd',
      channelId: PDD_CHANNEL,
      entries: [position(pddItem('b', 2), '2'), position(pddItem('a', 1), '1')],
      keys: ['pdd:g2', 'pdd:g1'],
    },
  ] as const;
  useCaseWhitelist(WHITELIST);
  for (const { code, channelId, entries, keys } of cases) {
    const f = fixture();
    f.fake(code).setPage({ items: entries, hasMore: false });

    const result = await fallbackSearch(f).run({ platform: code });

    expect(
      result.fallback_items.map((card) => card.product_key),
      code,
    ).toEqual(keys);
    expect(
      f.fake(code).rankingCalls.map((call) => call.req.channelId),
      code,
    ).toEqual([channelId]);
    const others = cases.filter((entry) => entry.code !== code);
    for (const other of others) {
      expect(f.fake(other.code).rankingCalls, other.code).toHaveLength(0);
    }
  }
});

it('[AC-B1-05n#3] pageSize 等于入参 limit，channelId 原样转给端口，推广位不进联盟请求', async () => {
  const f = fixture();
  const upstream = f.upstream();

  for (const limit of [1, 7, 50]) await upstream.materialFeed(feedRequest({ limit }));

  expect(f.fake('taobao').rankingCalls.map((call) => call.req)).toEqual(
    [1, 7, 50].map((limit) => ({
      channelId: TB_CHANNEL,
      categoryId: null,
      pageNo: 1,
      pageSize: limit,
    })),
  );
});

it('[AC-B1-05n#4] 调用上下文同现有 context(appId)：入参的 app、purpose online，每次一个新的 requestId', async () => {
  const f = fixture();
  const upstream = f.upstream();

  await upstream.materialFeed(feedRequest());
  await upstream.materialFeed(feedRequest());

  const contexts = f.fake('taobao').rankingCalls.map((call) => call.ctx);
  expect(contexts).toHaveLength(2);
  for (const ctx of contexts) {
    expect(ctx).toMatchObject({ appId: APP, purpose: 'online' });
    expect(typeof ctx.requestId).toBe('string');
    expect(ctx.requestId).not.toBe('');
  }
  expect(contexts[0]?.requestId).not.toBe(contexts[1]?.requestId);
});
