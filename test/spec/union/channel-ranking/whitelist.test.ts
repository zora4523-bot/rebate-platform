// BR-TEXT-17 细则「联盟物料频道」: only a (platform, channel) listed in the whitelist with
// selectable: true is fetched; anything else is no data plus a warning, and the union is not
// called. The whitelist is read again on every call (取数时再查一次).
import { expect, it } from 'vitest';
import {
  APP,
  EMPTY_PAGE,
  JD_CHANNEL,
  SECRET,
  TB_CHANNEL,
  channel,
  fakeAdapter,
  fixture,
  pageInput,
  warningText,
  type ChannelEntry,
  type Fixture,
} from './kit.ts';

/** One refused categories call and one refused page call: empty, one warning each, no union call. */
async function expectRefused(f: Fixture, platform: 'taobao' | 'jd' | 'pdd', channelId: string) {
  const port = f.port();
  const before = f.warnings.length;
  expect(await port.categories({ appId: APP, platform, channelId })).toEqual([]);
  expect(f.warnings.length - before, 'one warning for the refused categories call').toBe(1);
  expect(await port.page(pageInput({ platform, channelId }))).toEqual(EMPTY_PAGE);
  expect(f.warnings.length - before, 'one warning for the refused page call').toBe(2);
  expect(f.channelCalls(), 'a refused channel never reaches the union').toBe(0);
  const text = warningText(f.warnings.slice(before));
  expect(text, 'the warning names the channel').toContain(channelId);
  expect(text, 'the warning names the platform').toContain(platform);
  expect(text, 'no credential in a warning').not.toContain(SECRET);
}

it('[AC-B1-22p#1][BR-TEXT-17] 白名单内且 selectable 的频道：类目与榜单各调一次联盟，结果原样返回，不告警', async () => {
  const f = fixture();
  const port = f.port();
  const fake = f.fake('taobao');
  const categories = await port.categories({
    appId: APP,
    platform: 'taobao',
    channelId: TB_CHANNEL,
  });
  expect(categories).toEqual([
    { categoryId: 'synthetic-cat-b', name: '合成类目 B' },
    { categoryId: 'synthetic-cat-a', name: '合成类目 A' },
  ]);
  const page = await port.page(pageInput());
  expect(page.items.map((position) => position.item.title)).toEqual([
    'synthetic-first',
    'synthetic-second',
  ]);
  expect(fake.categoryCalls).toHaveLength(1);
  expect(fake.rankingCalls).toHaveLength(1);
  expect(fake.otherCalls).toEqual([]);
  expect(f.warnings).toEqual([]);
});

it.each<[string, readonly ChannelEntry[], 'taobao' | 'jd' | 'pdd', string]>([
  ['白名单为空', [], 'taobao', TB_CHANNEL],
  ['频道标识不在白名单', [channel('taobao', TB_CHANNEL)], 'taobao', 'synthetic-tb-commission'],
  ['同一频道标识登记在别的平台', [channel('jd', TB_CHANNEL)], 'taobao', TB_CHANNEL],
  ['只差大小写', [channel('taobao', TB_CHANNEL)], 'taobao', TB_CHANNEL.toUpperCase()],
  ['多一个空格', [channel('taobao', TB_CHANNEL)], 'taobao', `${TB_CHANNEL} `],
  ['别的平台的频道都在、本平台没有', [channel('jd', JD_CHANNEL)], 'pdd', JD_CHANNEL],
])(
  '[AC-B1-22p#2][BR-TEXT-17] %s → 不调联盟，类目回 []、榜单回空页且 hasMore=false，各记一条不含凭据的告警',
  async (_case, list, platform, channelId) => {
    const f = fixture(list);
    await expectRefused(f, platform, channelId);
  },
);

it('[AC-B1-22p#3][BR-TEXT-17] 登记在白名单但 selectable=false 的频道 → 按不在白名单处理：不调联盟、回空、告警', async () => {
  const f = fixture([
    channel('taobao', TB_CHANNEL, { selectable: false }),
    channel('jd', JD_CHANNEL, { selectable: false, sort_basis: 'popularity' }),
  ]);
  await expectRefused(f, 'taobao', TB_CHANNEL);
  await expectRefused(f, 'jd', JD_CHANNEL);
});

it('[AC-B1-22p#4][BR-TEXT-17] 白名单每次调用都重读：改为不可选后下一次即停用，恢复后下一次即重新取数', async () => {
  const f = fixture();
  const port = f.port();
  const fake = f.fake('taobao');

  await port.page(pageInput());
  expect(fake.rankingCalls).toHaveLength(1);
  const afterFirst = f.reads.channels;
  expect(afterFirst, 'the whitelist is read for the call').toBeGreaterThanOrEqual(1);

  f.setChannels([channel('taobao', TB_CHANNEL, { selectable: false })]);
  expect(await port.page(pageInput())).toEqual(EMPTY_PAGE);
  expect(await port.categories({ appId: APP, platform: 'taobao', channelId: TB_CHANNEL })).toEqual(
    [],
  );
  expect(fake.rankingCalls, 'no page fetched after the channel was turned off').toHaveLength(1);
  expect(fake.categoryCalls).toHaveLength(0);
  expect(f.warnings).toHaveLength(2);
  expect(f.reads.channels, 'read again on every call').toBeGreaterThanOrEqual(afterFirst + 2);

  f.setChannels([]);
  expect(await port.page(pageInput())).toEqual(EMPTY_PAGE);
  expect(fake.rankingCalls).toHaveLength(1);

  f.setChannels([channel('taobao', TB_CHANNEL)]);
  await port.page(pageInput({ pageNo: 2 }));
  await port.categories({ appId: APP, platform: 'taobao', channelId: TB_CHANNEL });
  expect(fake.rankingCalls).toHaveLength(2);
  expect(fake.rankingCalls[1]?.req.pageNo).toBe(2);
  expect(fake.categoryCalls).toHaveLength(1);
  expect(f.warnings, 'no warning once the channel is selectable again').toHaveLength(3);
});

it('[AC-B1-22p#5][BR-TEXT-17] 先核对白名单：不在白名单时即使平台没有适配器或适配器不支持频道，也只回空并告警，不报联盟故障', async () => {
  const noAdapter = fixture([]);
  noAdapter.setAdapter('taobao', undefined);
  await expectRefused(noAdapter, 'taobao', TB_CHANNEL);

  const notCapable = fixture([channel('jd', JD_CHANNEL, { selectable: false })]);
  notCapable.setAdapter('jd', fakeAdapter('jd', false).adapter);
  await expectRefused(notCapable, 'jd', JD_CHANNEL);
});

it.each(['sales', 'popularity', 'personalized'] as const)(
  '[AC-B1-22p#6][BR-TEXT-17] 端口只看 selectable：排序依据 %s 的可选频道都照常取数（是否进热销榜由 catalog 判）',
  async (sortBasis) => {
    const f = fixture([channel('jd', JD_CHANNEL, { sort_basis: sortBasis })]);
    const port = f.port();
    await port.categories({ appId: APP, platform: 'jd', channelId: JD_CHANNEL });
    await port.page(pageInput({ platform: 'jd', channelId: JD_CHANNEL }));
    expect(f.fake('jd').categoryCalls).toHaveLength(1);
    expect(f.fake('jd').rankingCalls).toHaveLength(1);
    expect(f.warnings).toEqual([]);
  },
);
