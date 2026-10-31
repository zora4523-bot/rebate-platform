import { expect, it } from 'vitest';
import {
  addLink,
  addRef,
  audit,
  bounds,
  fields,
  hoursFromNow,
  instant,
  itemRow,
  linkOf,
  newPoolId,
  OFF_SHELF_REASON,
  otherApp,
  pick,
  product,
  rejected,
  seedAlias,
  seedItem,
  seedPool,
  send,
  setConfig,
  setup,
  snapshot,
  stableId,
  stubProduct,
  success,
  union,
  useHarness,
  type Setup,
} from './kit.ts';
import { DemoUnionError, UnionError } from '../../../../apps/api/src/modules/union/index.ts';

const h = useHarness();

const offShelf = () => new UnionError('item_unavailable', 'synthetic off shelf', 'taobao');
const outage = () => new UnionError('upstream_unavailable', 'synthetic outage', 'taobao');

it('[AC-B1-05q#20] 链接入库：服务端派生 key，价格与 quoted_at 取本次联盟应答，online，创建人是操作者', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const stable = stableId();
  const item = product(f, stable);
  stubProduct(item);
  const before = await snapshot(h, f.appId);
  const end = hoursFromNow(f, 24);
  const added = await success(await addLink(f, pool, linkOf(item.item_id!), bounds(10, null, end)));
  expect(added).toMatchObject({
    product_key: `tb:${stable}`,
    platform: 'taobao',
    title: item.title,
    price_fen: 3990,
    coupon_fen: 1000,
    final_price_fen: 2990,
    status: 'online',
    sort: 10,
    start_at: null,
    invalid_reason: null,
    created_by: f.actor.id,
  });
  expect(instant(added.end_at)).toBe(end);
  expect(instant(added.quoted_at)).toBe(item.quoted_at);
  expect(instant(added.created_at)).toBe(f.clock.now().toISOString());
  const row = await itemRow(h, f, pool, `tb:${stable}`);
  expect(row).toMatchObject({
    app_id: f.appId,
    platform: 'taobao',
    raw_item_id: item.item_id,
    price_fen: 3990n,
    coupon_fen: 1000n,
    final_price_fen: 2990n,
    status: 'online',
    created_by: f.actor.id,
  });
  const entry = await audit(h, f, before, 'pool_item_add');
  expect(entry.before).toBeNull();
  expect(entry.after).toMatchObject({
    pool_id: pool,
    product_key: `tb:${stable}`,
    sort: 10,
    status: 'online',
  });
});

it.each([
  {
    name: '淘宝取原串 - 后最后一段',
    link: 'https://demo.invalid/taobao/AbC12xyz-7Kq9LmN3pQ',
    item: { platform: 'taobao', item_id: 'AbC12xyz-7Kq9LmN3pQ' },
    mode: null,
    key: 'tb:7Kq9LmN3pQ',
    raw: 'AbC12xyz-7Kq9LmN3pQ',
  },
  {
    name: '京东 item 模式取 B 段加 i_',
    link: 'https://demo.invalid/jd/dmA_B100',
    item: { platform: 'jd', itemId: 'dmA_B100' },
    mode: null,
    key: 'jd:i_B100',
    raw: 'dmA_B100',
  },
  {
    name: '京东 sku 模式取 skuId',
    link: 'https://demo.invalid/jd/dmA_B100',
    item: { platform: 'jd', itemId: 'dmA_B100', skuId: '100012043978' },
    mode: 'sku',
    key: 'jd:100012043978',
    raw: '100012043978',
  },
  {
    name: '拼多多取 goods_id，goods_sign 只作原串',
    link: 'https://demo.invalid/pdd/sign-A',
    item: { platform: 'pdd', goods_id: '123456789', goods_sign: 'sign-A' },
    mode: null,
    key: 'pdd:123456789',
    raw: 'sign-A',
  },
] as const)('[AC-B1-05q#21] $name（BR-PROD-03）', async ({ link, item, mode, key, raw }) => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  if (mode !== null) await setConfig(h, f, 'product_key.jd.mode', mode);
  stubProduct(product(f, 'unused', { item_id: null, ...item }));
  expect(await success(await addLink(f, pool, link))).toMatchObject({
    product_key: key,
    platform: item.platform,
  });
  expect(await itemRow(h, f, pool, key)).toMatchObject({ raw_item_id: raw });
});

it('[AC-B1-05q#22] 口令入库与链接同一条解析路径', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const stable = stableId();
  stubProduct(product(f, stable));
  const added = await success(await addLink(f, pool, '￥AbCdEf12￥'));
  expect(added.product_key).toBe(`tb:${stable}`);
  expect(union.resolveLink.mock.calls[0]?.[0]).toBe('￥AbCdEf12￥');
});

it('[AC-B1-05q#23] 选品入库：item_ref 原样透传，用它的原串问联盟，写 pool 来源的 product_refs，不登记 link', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const stable = stableId();
  const item = product(f, stable);
  const row = await pick(f, item);
  union.getItem.mockResolvedValue({ ...item, final_price_fen: 2500n, price_fen: 3500n });
  f.clock.advanceMs(1000);
  const before = await snapshot(h, f.appId);
  const added = await success(await addRef(f, pool, row.item_ref, bounds(3)));
  expect(added).toMatchObject({
    product_key: row.product_key,
    price_fen: 3500,
    final_price_fen: 2500,
    status: 'online',
    sort: 3,
  });
  expect(union.getItem).toHaveBeenCalledTimes(1);
  expect(union.getItem.mock.calls[0]?.[0]).toMatchObject({
    platform: 'taobao',
    item_id: item.item_id,
  });
  const state = await snapshot(h, f.appId);
  expect(state.refs).toHaveLength(1);
  expect(state.refs[0]).toMatchObject({
    product_key: row.product_key,
    platform: 'taobao',
    raw_item_id: item.item_id,
    source: 'pool',
    refreshed_at: f.clock.now(),
  });
  expect(state.links).toEqual(before.links);
  expect(state.linkLogs).toEqual(before.linkLogs);
  expect(union.convert).not.toHaveBeenCalled();
});

it('[AC-B1-05q#24] link_text 与 item_ref 同时给 → fields=[body]，都不给 → 三项都报，不问联盟不写入', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const before = await snapshot(h, f.appId);
  await fields(
    await send(
      f,
      'addItem',
      { pool },
      { link_text: linkOf('rawA-K24'), item_ref: 'v1.synthetic', ...bounds() },
    ),
    ['body'],
  );
  await fields(await send(f, 'addItem', { pool }, { ...bounds() }), [
    'link_text',
    'item_ref',
    'body',
  ]);
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(union.resolveLink).not.toHaveBeenCalled();
  expect(union.getItem).not.toHaveBeenCalled();
});

it('[AC-B1-05q#25] 控制台不能自带 product_key：多余字段 20001，不写入', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const before = await snapshot(h, f.appId);
  await rejected(
    await send(
      f,
      'addItem',
      { pool },
      { link_text: linkOf('rawA-K25'), product_key: 'tb:K25', ...bounds() },
    ),
    20001,
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#26] link_text 含两件不同商品 → fields=[link_text]，不写入', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const a = product(f, stableId());
  const b = product(f, stableId());
  union.resolveLink.mockImplementation((raw) =>
    Promise.resolve({
      item: { platform: 'taobao', item_id: raw.endsWith(a.item_id!) ? a.item_id! : b.item_id! },
    }),
  );
  union.getItem.mockImplementation((ref) => Promise.resolve(ref.item_id === a.item_id ? a : b));
  const before = await snapshot(h, f.appId);
  await fields(await addLink(f, pool, `${linkOf(a.item_id!)} ${linkOf(b.item_id!)}`), [
    'link_text',
  ]);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#27] 同一件商品的两个链接只算一件，入库一行', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const stable = stableId();
  const item = product(f, stable);
  stubProduct(item);
  const link = linkOf(item.item_id!);
  expect(await success(await addLink(f, pool, `${link} ${link}?ref=again`))).toMatchObject({
    product_key: `tb:${stable}`,
  });
  expect((await snapshot(h, f.appId)).items).toHaveLength(1);
});

it.each(['sort', 'start_at', 'end_at'] as const)(
  '[AC-B1-05q#28] 缺 %s → 20001 fields 指向它：三项必填，null 才表示不限',
  async (field) => {
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const body = Object.fromEntries(
      Object.entries({ link_text: linkOf('rawA-K28'), ...bounds() }).filter(([k]) => k !== field),
    );
    const before = await snapshot(h, f.appId);
    await fields(await send(f, 'addItem', { pool }, body), [field]);
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it.each([
  { name: 'end_at 等于 start_at', end: 1 },
  { name: 'end_at 早于 start_at', end: -1 },
])('[AC-B1-05q#29] $name → 20001 fields=[end_at]，不写入', async ({ end }) => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  stubProduct(product(f, stableId()));
  const before = await snapshot(h, f.appId);
  const at = bounds(0, hoursFromNow(f, 1), hoursFromNow(f, end));
  await fields(await addLink(f, pool, linkOf('rawA-K29'), at), ['end_at']);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#30] sort 为负 → 20001 fields=[sort]，不写入', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const before = await snapshot(h, f.appId);
  await fields(await addLink(f, pool, linkOf('rawA-K30'), bounds(-1)), ['sort']);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

const refusals = [
  {
    name: '文本里没有链接或口令',
    code: 30132,
    text: '这段话里没有商品',
    arrange: (): void => undefined,
  },
  {
    name: '联盟域名的非商品页',
    code: 30132,
    text: 'https://demo.invalid/home',
    arrange: (): void => undefined,
  },
  {
    name: '联盟不认这个链接',
    code: 30132,
    text: linkOf('rawA-unknown'),
    arrange: (): void => {
      union.resolveLink.mockRejectedValue(
        new UnionError('link_unrecognized', 'synthetic refusal', 'taobao'),
      );
    },
  },
  {
    name: '不在形态表里的链接',
    code: 30131,
    text: 'https://unknown.example.test/item/1',
    arrange: (): void => undefined,
  },
  {
    name: '认出商品但派生失败（原串以 - 结尾）',
    code: 30131,
    text: linkOf('AbC-'),
    arrange: (): void => {
      union.resolveLink.mockResolvedValue({ item: { platform: 'taobao', item_id: 'AbC-' } });
    },
  },
] as const;

it.each(refusals)(
  '[AC-B1-05q#31] $name → $code，不入库、不写 product_refs',
  async ({ code, text, arrange }) => {
    const f = await setup(h);
    const pool = await seedPool(h, f);
    arrange();
    const before = await snapshot(h, f.appId);
    await rejected(await addLink(f, pool, text), code);
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it('[AC-B1-05q#32] 口令解析开关关闭 → 30132，不问联盟', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await setConfig(h, f, 'parse.tpwd.enabled', false);
  const before = await snapshot(h, f.appId);
  await rejected(await addLink(f, pool, '￥AbCdEf12￥'), 30132);
  expect(union.resolveLink).not.toHaveBeenCalled();
  expect(await snapshot(h, f.appId)).toEqual(before);
});

async function forgedRefs(f: Setup) {
  const other = await otherApp(h, f);
  const foreign = await pick(other, product(f, stableId()));
  const own = await pick(f, product(f, stableId()));
  const middle = Math.floor(own.item_ref.length / 2);
  const flipped = own.item_ref[middle] === 'A' ? 'B' : 'A';
  return {
    garbage: 'synthetic-invalid-ref',
    tampered: `${own.item_ref.slice(0, middle)}${flipped}${own.item_ref.slice(middle + 1)}`,
    foreign: foreign.item_ref,
  };
}

it.each(['garbage', 'tampered', 'foreign'] as const)(
  '[AC-B1-05q#33] item_ref 解不开或属于别的 App（%s）→ 30132，不入库',
  async (kind) => {
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const refs = await forgedRefs(f);
    union.getItem.mockClear();
    const before = await snapshot(h, f.appId);
    await rejected(await addRef(f, pool, refs[kind]), 30132);
    expect(union.getItem).not.toHaveBeenCalled();
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it.each([
  { name: '联盟明确下架', error: offShelf },
  {
    name: '演示下架场景',
    error: () => new DemoUnionError('demo_delisted', 'synthetic off shelf', 'taobao'),
  },
])(
  '[AC-B1-05q#34] 新 key 且$name → 30141 不入库，但别的池里同 key 的条目下架并带原因',
  async ({ error }) => {
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const elsewhere = await seedPool(h, f);
    const row = await pick(f, product(f, stableId()));
    await seedItem(h, f, elsewhere, row.product_key);
    union.getItem.mockRejectedValue(error());
    await rejected(await addRef(f, pool, row.item_ref), 30141);
    expect(await itemRow(h, f, pool, row.product_key)).toBeUndefined();
    expect(await itemRow(h, f, elsewhere, row.product_key)).toMatchObject({
      status: 'offline',
      invalid_reason: OFF_SHELF_REASON,
    });
  },
);

it.each(['resolveLink', 'getItem'] as const)(
  '[AC-B1-05q#35] 联盟此刻答不了（%s）→ 50401，什么都不写',
  async (stage) => {
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const item = product(f, stableId());
    stubProduct(item);
    union[stage].mockRejectedValue(outage());
    const before = await snapshot(h, f.appId);
    await rejected(await addLink(f, pool, linkOf(item.item_id!)), 50401);
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it('[AC-B1-05q#36] 池不存在或写法不对 → 30701，不写入', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const item = product(f, stableId());
  stubProduct(item);
  const before = await snapshot(h, f.appId);
  for (const target of [newPoolId(), pool.toUpperCase(), 'not-a-uuid']) {
    await rejected(await addLink(f, target, linkOf(item.item_id!)), 30701);
  }
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#37] 停用的池也能入库', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f, { status: 'disabled' });
  const item = product(f, stableId());
  stubProduct(item);
  expect(await success(await addLink(f, pool, linkOf(item.item_id!)))).toMatchObject({
    status: 'online',
  });
});

it('[AC-B1-05q#38] 用户粘贴的分享文案不进池条目、product_refs 和审计（BR-PROD-05）', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const item = product(f, stableId());
  stubProduct(item);
  const marker = '合成分享文案-别人的推广参数';
  await success(await addLink(f, pool, `${marker} ${linkOf(item.item_id!)}?ref=someone-else`));
  const state = await snapshot(h, f.appId);
  const stored = JSON.stringify([state.items, state.refs, state.audits], (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  expect(stored).not.toContain(marker);
  expect(stored).not.toContain('someone-else');
});

it('[AC-B1-05q#39] item_ref 与输入原文不进日志（BR-PROD-11）', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const row = await pick(f, product(f, stableId()));
  union.getItem.mockResolvedValue(product(f, row.product_key.slice('tb:'.length)));
  await success(await addRef(f, pool, row.item_ref));
  const item = product(f, stableId());
  stubProduct(item);
  const marker = '合成分享文案-日志';
  await success(await addLink(f, pool, `${marker} ${linkOf(item.item_id!)}`));
  const logged = f.lines.join('\n');
  expect(logged).not.toContain(row.item_ref);
  expect(logged).not.toContain(marker);
});

it('[AC-B1-05q#40] 派生出的旧键解析别名后命中池里的条目，同一商品仍是一行（BR-PROD-08）', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const oldStable = stableId('Old');
  const newKey = `tb:${stableId('New')}`;
  await seedAlias(h, `tb:${oldStable}`, newKey);
  await seedItem(h, f, pool, newKey, { sort: 1 });
  const item = product(f, oldStable);
  stubProduct(item);
  f.clock.advanceMs(1000);
  expect(await success(await addLink(f, pool, linkOf(item.item_id!), bounds(9)))).toMatchObject({
    product_key: newKey,
    sort: 9,
  });
  const state = await snapshot(h, f.appId);
  expect(state.items.map((row) => row.product_key)).toEqual([newKey]);
});
