// B1-28j: 「无数据」 keeps B1-28h's 50304 rule (BR-TEXT-17 细则「联盟物料频道」「取数时再查一次」).
// Before every fetch the wiring reads the whitelist itself: a (platform, channel_id) that is not
// listed, or listed with selectable other than true, is CatalogError 50304 data.reason =
// rank_unavailable with one warning and no adapter call — never an empty list passed off as the
// channel. A listed channel whose page is empty is an empty list, not an error.
import { expect, it } from 'vitest';
import { CatalogError } from '../../../../apps/api/src/modules/catalog/domain/rules.ts';
import type { MaterialChannelsSpec } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  APP,
  JD_CHANNEL,
  TB_CHANNEL,
  channel,
  dataOf,
  fixture,
  hotRank,
  pageRequest,
  position,
  rejection,
  tbItem,
  warningText,
  type ChannelEntry,
  type Fixture,
} from './kit.ts';

function expectRankUnavailable(error: unknown, platform: string): void {
  expect(error).toBeInstanceOf(CatalogError);
  expect(error).toMatchObject({ code: 50304 });
  expect(dataOf(error)).toEqual({ platform, reason: 'rank_unavailable' });
}

const REFUSED: readonly { readonly label: string; readonly list: readonly ChannelEntry[] }[] = [
  { label: '白名单为空', list: [] },
  { label: '频道不在白名单', list: [channel('taobao', 'synthetic_tb_other')] },
  { label: '同名频道只登记在别的平台', list: [channel('jd', TB_CHANNEL)] },
  { label: '频道已标为不可选', list: [channel('taobao', TB_CHANNEL, { selectable: false })] },
];

async function refusedCall(f: Fixture, kind: 'categories' | 'page'): Promise<unknown> {
  const upstream = f.upstream();
  if (kind === 'page') return rejection(() => upstream.page(pageRequest()));
  return rejection(() =>
    upstream.categories({ appId: APP, platform: 'taobao', channelId: TB_CHANNEL }),
  );
}

it('[AC-B1-28j#18][BR-TEXT-17] categories / page 取数前自己核对白名单：不在白名单、只在别的平台或不可选 → 50304 rank_unavailable，不调 adapter，告警一条（带频道）', async () => {
  for (const { label, list } of REFUSED) {
    for (const kind of ['categories', 'page'] as const) {
      const f = fixture({ whitelist: list });
      f.fake('taobao').setCategories([{ categoryId: 'synthetic-cat', name: '合成类目' }]);
      f.fake('taobao').setPage({ items: [position(tbItem('a', 1), '1')], hasMore: false });

      const error = await refusedCall(f, kind);

      expectRankUnavailable(error, 'taobao');
      expect(f.channelCalls(), `${label} ${kind}`).toBe(0);
      expect(f.warnings, `${label} ${kind}`).toHaveLength(1);
      expect(warningText(f.warnings)).toContain(TB_CHANNEL);
      expect(f.reads.channels).toBeGreaterThan(0);
    }
  }
});

it('[AC-B1-28j#19] 每次取数前都重读白名单：频道改为不可选后下一次即拒绝，恢复可选后又能取数', async () => {
  const f = fixture();
  f.fake('taobao').setPage({ items: [position(tbItem('a', 1), '1')], hasMore: false });
  const upstream = f.upstream();

  expect((await upstream.page(pageRequest())).items).toHaveLength(1);
  const readsAfterFirst = f.reads.channels;
  expect(readsAfterFirst).toBeGreaterThan(0);

  f.setChannels([channel('taobao', TB_CHANNEL, { selectable: false })]);
  expectRankUnavailable(await rejection(() => upstream.page(pageRequest())), 'taobao');
  expect(f.reads.channels).toBeGreaterThan(readsAfterFirst);
  expect(f.fake('taobao').rankingCalls).toHaveLength(1);

  f.setChannels([channel('taobao', TB_CHANNEL)]);
  expect((await upstream.page(pageRequest())).items).toHaveLength(1);
  expect(f.fake('taobao').rankingCalls).toHaveLength(2);
});

it('[AC-B1-28j#20] 经 getHotRank：用例那一刻频道可用、wiring 取数时已不可选 → 50304 rank_unavailable，不向联盟取数', async () => {
  const f = fixture({ whitelist: [channel('taobao', TB_CHANNEL, { selectable: false })] });
  f.fake('taobao').setPage({ items: [position(tbItem('a', 1), '1')], hasMore: false });
  const atUseCase: MaterialChannelsSpec = {
    version: 'synthetic-use-case',
    channels: [channel('taobao', TB_CHANNEL)],
  };

  const error = await rejection(() => hotRank(f, { channels: () => atUseCase })());

  expectRankUnavailable(error, 'taobao');
  expect(f.channelCalls()).toBe(0);
});

it('[AC-B1-28j#21] 白名单内频道上游给空页：page 为空列表、hasMore=false，接口 items 为空、next_cursor=null，不是错误', async () => {
  const f = fixture();
  f.fake('taobao').setCategories([]);
  f.fake('taobao').setPage({ items: [], hasMore: false });

  const page = await f.upstream().page(pageRequest());
  expect(page).toEqual({ items: [], hasMore: false });

  const data = await hotRank(f)();
  expect(data.channel).toBe(TB_CHANNEL);
  expect(data.items).toEqual([]);
  expect(data.categories).toEqual([]);
  expect(data.next_cursor).toBeNull();
});

it('[AC-B1-28j#22] 一页条目全都推导不出 product_key 时同样是空列表而不是错误', async () => {
  const f = fixture();
  f.fake('jd').setPage({ items: [position(tbItem('foreign', 1), '1')], hasMore: false });

  const page = await f.upstream().page(pageRequest({ platform: 'jd', channelId: JD_CHANNEL }));

  expect(page).toEqual({ items: [], hasMore: false });
  expect(f.fake('jd').rankingCalls).toHaveLength(1);
});
