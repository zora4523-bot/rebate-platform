// adminSearchPoolCandidates：游标分页是登记例外（D10-485），联盟一律用演示适配器的规范化 DTO。
import { expect, it } from 'vitest';
import {
  addRef,
  age,
  candidates,
  fields,
  itemRow,
  member,
  PERMISSION,
  product,
  rejected,
  searchAnswers,
  seedItem,
  seedPool,
  send,
  setConfig,
  setup,
  snapshot,
  stableId,
  success,
  union,
  useHarness,
  type CandidateList,
  type Setup,
} from './kit.ts';
import { UnionError, type UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';

const h = useHarness();

/** 一页 n 件互不相同的商品。 */
const page = (f: Setup, size: number) => Array.from({ length: size }, () => product(f, stableId()));
const keyOf = (item: UnionItemDetail) => `tb:${item.item_id!.split('-').pop()!}`;
const keysOf = (list: CandidateList) => list.items.map((row) => row.product_key);
const search = async (
  f: Setup,
  query: Record<string, string> = {},
  options: { token?: string } = {},
) => success<CandidateList>(await candidates(f, query, options));
const noRebate = (list: CandidateList) => {
  for (const row of list.items) {
    expect(Object.keys(row).filter((name) => name.includes('rebate'))).toEqual([]);
  }
};

it('[AC-B1-05q#80] 候选带 item_ref 与报价，不下发返利，不登记 link，不进池，不写审计', async () => {
  const f = await setup(h);
  const item = product(f, stableId());
  searchAnswers([[item]]);
  const before = await snapshot(h, f.appId);
  const list = await search(f);
  expect(list.next_cursor).toBeNull();
  expect(list).not.toHaveProperty('total');
  expect(list.items).toHaveLength(1);
  expect(list.items[0]).toMatchObject({
    product_key: keyOf(item),
    platform: 'taobao',
    title: item.title,
    price_fen: 3990,
    coupon_fen: 1000,
    final_price_fen: 2990,
    quoted_at: expect.any(String),
    item_ref: expect.any(String),
  });
  noRebate(list);
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(union.convert).not.toHaveBeenCalled();
});

it('[AC-B1-05q#81] 服务端页大小 20：联盟一页给得更多也只出 20 条', async () => {
  const f = await setup(h);
  searchAnswers([page(f, 25)]);
  expect((await search(f)).items).toHaveLength(20);
});

it('[AC-B1-05q#82] 缺 platform 或 q、q 超 100 字符 → 20001 指向该字段，不问联盟', async () => {
  const f = await setup(h);
  for (const [query, field] of [
    ['?q=abc', 'platform'],
    ['?platform=taobao', 'q'],
    ['?platform=taobao&q=', 'q'],
    [`?platform=taobao&q=${'字'.repeat(101)}`, 'q'],
  ] as const) {
    await fields(await send(f, 'candidates', {}, undefined, { query: encodeURI(query) }), [field]);
  }
  expect(union.searchItems).not.toHaveBeenCalled();
});

it('[AC-B1-05q#83] 平台没有搜索能力 → 30131（BR-PROD-10）', async () => {
  const f = await setup(h);
  await rejected(await candidates(f, { platform: 'suning' }), 30131);
  expect(union.searchItems).not.toHaveBeenCalled();
});

it('[AC-B1-05q#84] 搜索开关关闭 → 50304 search_disabled，不问联盟', async () => {
  const f = await setup(h);
  await setConfig(h, f, 'search.enabled.taobao', false);
  await rejected(await candidates(f), 50304, { platform: 'taobao', reason: 'search_disabled' });
  expect(union.searchItems).not.toHaveBeenCalled();
});

it('[AC-B1-05q#85] 联盟故障且无可用缓存 → 50304，不拿商品池冒充', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await seedItem(h, f, pool, 'tb:InPool');
  union.searchItems.mockRejectedValue(
    new UnionError('upstream_unavailable', 'synthetic outage', 'taobao'),
  );
  await rejected(await candidates(f), 50304, { platform: 'taobao' });
});

it('[AC-B1-05q#86] 无结果 200 空列表、next_cursor 为空，没有兜底', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await seedItem(h, f, pool, 'tb:InPool');
  searchAnswers([[]]);
  const list = await search(f);
  expect(list).toEqual({ items: [], next_cursor: null });
  expect(union.materialFeed).not.toHaveBeenCalled();
  expect(union.channelRanking).not.toHaveBeenCalled();
});

it('[AC-B1-05q#87] 无返利商品也出现在候选里（BR-PRICE-08 的过滤在读池时做）', async () => {
  const f = await setup(h);
  const item = product(f, stableId(), { commission_rate_bp: 0n });
  searchAnswers([[item]]);
  expect((await search(f)).items).toHaveLength(1);
});

it('[AC-B1-05q#88] 派生失败的行丢弃，其余照出（BR-PROD-03）', async () => {
  const f = await setup(h);
  const good = product(f, 'Good88');
  searchAnswers([[product(f, 'Bad88', { item_id: 'AbC-' }), good]]);
  expect(keysOf(await search(f))).toEqual(['tb:Good88']);
});

function plan(f: Setup, sign: string, finalFen: bigint, commissionBp: bigint) {
  return product(f, 'unused', {
    platform: 'pdd',
    item_id: null,
    goods_id: '123456789',
    goods_sign: sign,
    final_price_fen: finalFen,
    commission_rate_bp: commissionBp,
  });
}

const TIES: readonly {
  name: string;
  plans: readonly (readonly [string, bigint, bigint])[];
  kept: string;
}[] = [
  {
    name: '券后价低的优先，不看返利',
    plans: [
      ['S1', 1990n, 3000n],
      ['S2', 1890n, 100n],
    ],
    kept: 'S2',
  },
  {
    name: '同价取内部算出的返利高的',
    plans: [
      ['S1', 1890n, 100n],
      ['S2', 1890n, 3000n],
    ],
    kept: 'S2',
  },
  {
    name: '同价同返利取排序靠前的',
    plans: [
      ['S1', 1890n, 3000n],
      ['S2', 1890n, 3000n],
    ],
    kept: 'S1',
  },
];

it.each(TIES)(
  '[AC-B1-05q#89] 同键多计划只留一行：$name，item_ref 是留下那条的',
  async ({ plans, kept }) => {
    const f = await setup(h);
    const pool = await seedPool(h, f);
    searchAnswers([plans.map(([sign, final, rate]) => plan(f, sign, final, rate))]);
    const list = await search(f, { platform: 'pdd' });
    expect(keysOf(list)).toEqual(['pdd:123456789']);
    noRebate(list);
    union.getItem.mockResolvedValue(plan(f, kept, 1890n, 3000n));
    await success(await addRef(f, pool, list.items[0]!.item_ref));
    expect(union.getItem.mock.calls[0]?.[0]).toMatchObject({ goods_sign: kept });
    expect(await itemRow(h, f, pool, 'pdd:123456789')).toMatchObject({ raw_item_id: kept });
  },
);

/** 第 1 页 20 条，第 2 页 3 条新品加 1 条第 1 页出现过的。 */
function twoPages(f: Setup) {
  const first = page(f, 20);
  const second = [first[19]!, ...page(f, 3)];
  searchAnswers([first, second]);
  return { first, second };
}

it('[AC-B1-05q#90] 同一会话翻页剔除已下发的键，next_cursor 用完为空（BR-PROD-08 ②）', async () => {
  const f = await setup(h);
  const { second } = twoPages(f);
  const one = await search(f);
  expect(one.items).toHaveLength(20);
  expect(one.next_cursor).toEqual(expect.any(String));
  const two = await search(f, { cursor: one.next_cursor! });
  expect(keysOf(two)).toEqual(second.slice(1).map(keyOf));
  expect(two.next_cursor).toBeNull();
});

it('[AC-B1-05q#91] 解不开的游标 → 20001 fields=[cursor]，不问联盟', async () => {
  const f = await setup(h);
  searchAnswers([[]]);
  await fields(await candidates(f, { cursor: 'not-a-cursor' }), ['cursor']);
  expect(union.searchItems).not.toHaveBeenCalled();
});

it('[AC-B1-05q#92] 过期会话的游标不报错：开新会话，返回所请求的页，已下发集合从空开始', async () => {
  const f = await setup(h);
  const { second } = twoPages(f);
  const one = await search(f);
  await age(f, 1_801_000);
  const two = await search(f, { cursor: one.next_cursor! });
  expect(keysOf(two)).toEqual(second.map(keyOf));
});

it('[AC-B1-05q#93] 别的管理员的游标不报错：开新会话，返回所请求的页', async () => {
  const f = await setup(h);
  const { second } = twoPages(f);
  const other = await member(h, f, [PERMISSION]);
  const one = await search(f);
  const two = await search(f, { cursor: one.next_cursor! }, { token: other.token });
  expect(keysOf(two)).toEqual(second.map(keyOf));
});

it('[AC-B1-05q#94] 同一查询在缓存窗口内不再问联盟（BR-PROD-07）', async () => {
  const f = await setup(h);
  const item = product(f, stableId());
  searchAnswers([[item]]);
  const first = await search(f, { q: '缓存' });
  const second = await search(f, { q: '缓存' });
  expect(union.searchItems).toHaveBeenCalledTimes(1);
  expect(keysOf(second)).toEqual(keysOf(first));
});
