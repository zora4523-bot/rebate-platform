// B1-28h: the hot list reads only a selectable whitelisted channel of the platform, checked before
// every fetch (BR-TEXT-17 细则「联盟物料频道」「取数时再查一次」; 规划/01 F-PROD-13 ③). No compliant
// channel → 50304 data.reason=rank_unavailable, the same judgement as /v1/config
// features.rank_platforms (content's rankPlatforms over the same whitelist).
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { rankPlatforms } from '../../../../apps/api/src/modules/content/domain/config-etag.ts';
import type { Platform } from '../../../../apps/api/src/modules/union/index.ts';
import {
  TB_CHANNEL,
  candidate,
  channel,
  dataOf,
  fixture,
  rejection,
  type ChannelEntry,
} from './kit.ts';

const PLATFORMS: readonly Platform[] = ['taobao', 'jd', 'pdd'];

function channelIdsOf(f: ReturnType<typeof fixture>): string[] {
  return [
    ...f.categories.mock.calls.map(([input]) => `${input.platform}/${input.channelId}`),
    ...f.page.mock.calls.map(([input]) => `${input.platform}/${input.channelId}`),
  ];
}

it('[AC-B1-28h#1] 只取该平台白名单里可选的频道，一次请求只用一个频道（不合并多个频道），channel 即所用频道', async () => {
  const f = fixture();
  f.setChannels([
    channel('jd', 'synthetic_jd_sales'),
    channel('taobao', 'synthetic_tb_off', { selectable: false }),
    channel('taobao', 'synthetic_tb_hot', { sort_basis: 'popularity' }),
    channel('taobao', 'synthetic_tb_daily'),
  ]);
  for (const id of ['synthetic_tb_off', 'synthetic_tb_hot', 'synthetic_tb_daily']) {
    f.setPage('taobao', id, null, 1, [candidate(`${id}-1`)]);
  }

  const data = await f.run();

  expect(['synthetic_tb_hot', 'synthetic_tb_daily']).toContain(data.channel);
  const used = channelIdsOf(f);
  expect(used.length).toBeGreaterThan(0);
  expect(new Set(used)).toEqual(new Set([`taobao/${data.channel}`]));
  expect(data.items.map((item) => item.product_card.title)).toEqual([
    `synthetic-${data.channel}-1`,
  ]);
});

it('[AC-B1-28h#2] 该平台没有合规频道（白名单空、只有别的平台、只有不可选的）→ 50304 data.reason=rank_unavailable，不向联盟取数', async () => {
  const cases: readonly (readonly ChannelEntry[])[] = [
    [],
    [channel('jd', 'synthetic_jd_sales'), channel('pdd', 'synthetic_pdd_sales')],
    [channel('taobao', 'synthetic_tb_off', { selectable: false })],
  ];
  for (const list of cases) {
    const f = fixture();
    f.setChannels(list);
    const error = await rejection(() => f.run());
    expect(error, JSON.stringify(list)).toMatchObject({ code: 50304 });
    expect(dataOf(error)).toMatchObject({ platform: 'taobao', reason: 'rank_unavailable' });
    expect(f.categories).not.toHaveBeenCalled();
    expect(f.page).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
  }
});

it('[AC-B1-28h#3] 每次取数前都核对白名单：频道改为不可选后，下一次请求不再取数、按 rank_unavailable 处理并告警（带平台与频道）', async () => {
  const f = fixture();
  f.setPage('taobao', TB_CHANNEL, null, 1, [candidate('first')]);
  const first = await f.run();
  expect(first.channel).toBe(TB_CHANNEL);
  const reads = f.channels.mock.calls.length;
  const pageCalls = f.page.mock.calls.length;
  const categoryCalls = f.categories.mock.calls.length;

  f.setChannels([channel('taobao', TB_CHANNEL, { selectable: false })]);
  const error = await rejection(() => f.run());

  expect(f.channels.mock.calls.length).toBeGreaterThan(reads);
  expect(error).toMatchObject({ code: 50304 });
  expect(dataOf(error)).toMatchObject({ platform: 'taobao', reason: 'rank_unavailable' });
  expect(f.page.mock.calls.length).toBe(pageCalls);
  expect(f.categories.mock.calls.length).toBe(categoryCalls);
  expect(f.warn.mock.calls.map((call: unknown[]) => call[0])).toContainEqual(
    expect.objectContaining({ platform: 'taobao', channel_id: TB_CHANNEL }),
  );
});

it('[AC-B1-28h#4] 频道从白名单移出后，即使缓存里还有它的榜单也不再下发（保存时的校验管不到之后的白名单变更）', async () => {
  const f = fixture({ cached: true });
  f.setPage('taobao', TB_CHANNEL, null, 1, [candidate('cached')]);
  expect((await f.run()).items).toHaveLength(1);
  const pageCalls = f.page.mock.calls.length;

  f.setChannels([channel('jd', 'synthetic_jd_sales')]);
  const error = await rejection(() => f.run());

  expect(error).toMatchObject({ code: 50304 });
  expect(dataOf(error)).toMatchObject({ platform: 'taobao', reason: 'rank_unavailable' });
  expect(f.page.mock.calls.length).toBe(pageCalls);
});

it('[AC-B1-28h#5] 平台的可选频道换成另一个后，下一次请求用新频道取数，不拿旧频道的缓存冒充', async () => {
  const f = fixture({ cached: true });
  f.setPage('taobao', TB_CHANNEL, null, 1, [candidate('old-channel')]);
  f.setPage('taobao', 'synthetic_tb_new', null, 1, [candidate('new-channel')]);
  expect((await f.run()).channel).toBe(TB_CHANNEL);

  f.setChannels([
    channel('taobao', TB_CHANNEL, { selectable: false }),
    channel('taobao', 'synthetic_tb_new'),
  ]);
  const data = await f.run();

  expect(data.channel).toBe('synthetic_tb_new');
  expect(data.items.map((item) => item.product_card.title)).toEqual(['synthetic-new-channel']);
  expect(f.page.mock.calls.at(-1)?.[0]).toMatchObject({
    platform: 'taobao',
    channelId: 'synthetic_tb_new',
  });
});

const entryArb = fc.record({
  platform: fc.constantFrom<Platform>(...PLATFORMS),
  sort_basis: fc.constantFrom<'sales' | 'popularity'>('sales', 'popularity'),
  selectable: fc.boolean(),
});

it('[AC-B1-28h#6] 属性：任意白名单下，某平台 rank_unavailable 当且仅当它不在 rankPlatforms（features.rank_platforms 的口径）里；可用时 channel 是该平台的可选频道', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(fc.array(entryArb, { maxLength: 8 }), async (entries) => {
      const list = entries.map((entry, index) =>
        channel(entry.platform, `synthetic_ch_${index}`, {
          sort_basis: entry.sort_basis,
          selectable: entry.selectable,
        }),
      );
      const listed = rankPlatforms({ version: 'synthetic', channels: list });
      for (const platform of PLATFORMS) {
        const f = fixture();
        f.setChannels(list);
        const selectable = list
          .filter((entry) => entry.platform === platform && entry.selectable)
          .map((entry) => entry.channel_id);
        if (listed.includes(platform)) {
          const data = await f.run({ platform });
          expect(selectable).toContain(data.channel);
        } else {
          const error = await rejection(() => f.run({ platform }));
          expect(error).toMatchObject({ code: 50304 });
          expect(dataOf(error)).toMatchObject({ platform, reason: 'rank_unavailable' });
          expect(f.page).not.toHaveBeenCalled();
        }
        checked += 1;
      }
    }),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 120_000);
