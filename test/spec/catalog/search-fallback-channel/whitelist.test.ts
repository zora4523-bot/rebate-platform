// B1-05n: BR-TEXT-17 细则「取数时再查一次」on the fallback. The use case selects a channel from the
// whitelist; the port reads it again at fetch time. A (platform, channel_id) that left the whitelist
// in between, or is no longer selectable, is no data with one warning and no union call, and the
// fallback is simply empty. The new options are optional: without them the wiring reads platform's
// getMaterialChannels and a refusal must not fail for want of a logger.
import { afterEach, expect, it, vi } from 'vitest';
import {
  TB_CHANNEL,
  WHITELIST,
  channel,
  fallbackSearch,
  feedRequest,
  fixture,
  memoryRedis,
  position,
  tbItem,
  useCaseWhitelist,
  type ChannelEntry,
} from './kit.ts';

afterEach(() => vi.restoreAllMocks());

const REFUSED: readonly {
  readonly label: string;
  readonly list: readonly ChannelEntry[];
  readonly reason: string;
}[] = [
  { label: '白名单已清空', list: [], reason: 'not_listed' },
  { label: '频道被移出', list: [channel('taobao', 'synthetic_tb_other')], reason: 'not_listed' },
  { label: '同名频道只登记在别的平台', list: [channel('jd', TB_CHANNEL)], reason: 'not_listed' },
  {
    label: '频道改为不可选',
    list: [channel('taobao', TB_CHANNEL, { selectable: false })],
    reason: 'not_selectable',
  },
];

it('[AC-B1-05n#12][BR-TEXT-17] 用例选中频道后白名单变了：不调 channelRanking 也不调 materialFeed，兜底为空，告警一条（带平台、频道、原因）', async () => {
  useCaseWhitelist(WHITELIST);
  for (const { label, list, reason } of REFUSED) {
    const f = fixture();
    f.fake('taobao').setPage({ items: [position(tbItem('a', 1), '1')], hasMore: true });
    const search = fallbackSearch(f);
    f.setChannels(list);

    const result = await search.run();

    expect(result, label).toEqual({
      items: [],
      next_cursor: null,
      has_more: false,
      fallback_items: [],
    });
    expect(f.fake('taobao').rankingCalls, label).toHaveLength(0);
    expect(f.fake('taobao').feedCalls(), label).toBe(0);
    expect(f.warnings, label).toHaveLength(1);
    expect(f.warnings[0]?.[0], label).toMatchObject({
      event: 'union_channel_refused',
      operation: 'channelRanking',
      platform: 'taobao',
      channelId: TB_CHANNEL,
      reason,
    });
    expect(search.warn, label).not.toHaveBeenCalled();
  }
});

it('[AC-B1-05n#13][BR-TEXT-17] 每次取数都重读白名单：同一 upstream 上频道移出后下一次即空，恢复后又能取数', async () => {
  const f = fixture();
  f.fake('taobao').setPage({ items: [position(tbItem('a', 1), '1')], hasMore: true });
  const upstream = f.upstream();

  const before = await upstream.materialFeed(feedRequest());
  expect(before.items.map((candidate) => candidate.item.title)).toEqual(['synthetic-a']);

  f.setChannels([]);
  expect(await upstream.materialFeed(feedRequest())).toEqual({ items: [], hasMore: false });
  expect(f.fake('taobao').rankingCalls).toHaveLength(1);

  f.setChannels(WHITELIST);
  const after = await upstream.materialFeed(feedRequest());
  expect(after.items.map((candidate) => candidate.item.title)).toEqual(['synthetic-a']);
  expect(f.fake('taobao').rankingCalls).toHaveLength(2);
});

it('[AC-B1-05n#14] 兜底不进搜索页缓存：同一搜索再来一次，频道已移出时不拿上次的频道页顶替', async () => {
  useCaseWhitelist(WHITELIST);
  const f = fixture();
  f.fake('taobao').setPage({ items: [position(tbItem('a', 1), '1')], hasMore: false });
  const memory = memoryRedis();
  const search = fallbackSearch(f, { redis: memory.redis });

  const first = await search.run();
  f.setChannels([]);
  const second = await search.run();

  expect(first.fallback_items.map((card) => card.title)).toEqual(['synthetic-a']);
  expect(second.fallback_items).toEqual([]);
  expect(f.fake('taobao').rankingCalls).toHaveLength(1);
  expect(f.warnings).toHaveLength(1);
  expect([...memory.rows.values()].join('\n')).not.toContain('synthetic-a');
});

it('[AC-B1-05n#15] 不传 channels 时默认读 platform 的 getMaterialChannels，且每次取数重读', async () => {
  useCaseWhitelist(WHITELIST);
  const f = fixture();
  f.fake('taobao').setPage({ items: [position(tbItem('a', 1), '1')], hasMore: false });
  const upstream = f.bareUpstream();

  const page = await upstream.materialFeed(feedRequest());

  expect(page.items.map((candidate) => candidate.item.title)).toEqual(['synthetic-a']);
  expect(f.fake('taobao').rankingCalls).toHaveLength(1);

  useCaseWhitelist([channel('taobao', TB_CHANNEL, { selectable: false })]);
  expect(await upstream.materialFeed(feedRequest())).toEqual({ items: [], hasMore: false });
  expect(f.fake('taobao').rankingCalls).toHaveLength(1);
});

it('[AC-B1-05n#16] 不传 logger 时拒绝仍是空结果：冻结调用方的选项形状不因告警而失败', async () => {
  useCaseWhitelist([]);
  const f = fixture();
  f.fake('taobao').setPage({ items: [position(tbItem('a', 1), '1')], hasMore: false });

  const page = await f.bareUpstream().materialFeed(feedRequest());

  expect(page).toEqual({ items: [], hasMore: false });
  expect(f.fake('taobao').rankingCalls).toHaveLength(0);
  expect(f.fake('taobao').feedCalls()).toBe(0);
});
