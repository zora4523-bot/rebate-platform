// B1-05r (任务书第 9 节「入库时也写 commission_rate_bp」, B1-05u): pool-source's new key, a re-checked
// repeat add and a re-listing all write the rate the union answered into pool_items, so the row can
// be sent without waiting for a refresh. A re-listing also stops reading quoted_at as the raw ID's
// age, now that a refresh moves it. Through the real admin routes of B1-05q; the admin kit holds the
// vi.mock calls and the union stubs, and only values are imported from it.
import { expect, it } from 'vitest';
import {
  addLink,
  addRef,
  bounds,
  itemRow,
  linkOf,
  pick,
  product,
  searchAnswers,
  seedItem,
  seedPool,
  seedRef,
  send,
  setup,
  stableId,
  stubProduct,
  success,
  union,
  useHarness,
  type Setup,
} from '../product-pool-admin/kit.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';

const h = useHarness();

const ADDED_MS = 3 * 86_400_000;
const REFRESHED_MS = 600_000;

/** A shelved row added days ago whose price a refresh rewrote 10 minutes ago, raw ID untouched. */
async function refreshedOffline(f: Setup) {
  const pool = await seedPool(h, f);
  const stable = stableId();
  const key = `tb:${stable}`;
  const now = f.clock.now().getTime();
  await seedItem(h, f, pool, key, {
    status: 'offline',
    invalid_reason: null,
    created_at: new Date(now - ADDED_MS),
    quoted_at: new Date(now - REFRESHED_MS),
  });
  return { pool, stable, key, raw: `rawA-${stable}` };
}

const usedRaws = () => union.getItem.mock.calls.map(([ref]) => ref.item_id);

it('[BR-PRICE-11][B1-05u] 链接入库新 key：commission_rate_bp 写入联盟答复的佣金率', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const stable = stableId();
  const item = product(f, stable, { commission_rate_bp: 1234n });
  stubProduct(item);

  await success(await addLink(f, pool, linkOf(item.item_id!)));

  expect((await itemRow(h, f, pool, `tb:${stable}`))?.commission_rate_bp).toBe(1234);
});

it('[BR-PRICE-11][B1-05u] 候选 item_ref 入库新 key：commission_rate_bp 写入联盟答复的佣金率', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const stable = stableId();
  const item = product(f, stable, { commission_rate_bp: 1234n });
  const candidate = await pick(f, item);
  stubProduct(item);

  await success(await addRef(f, pool, candidate.item_ref));

  expect((await itemRow(h, f, pool, `tb:${stable}`))?.commission_rate_bp).toBe(1234);
});

it('[BR-PRICE-11][B1-05u] 佣金率为 0 也写 0，不写成 NULL', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const stable = stableId();
  const item = product(f, stable, { commission_rate_bp: 0n });
  stubProduct(item);

  await success(await addLink(f, pool, linkOf(item.item_id!)));

  expect((await itemRow(h, f, pool, `tb:${stable}`))?.commission_rate_bp).toBe(0);
});

it('[BR-PRICE-11][BR-PROD-08] 复核通过的重复入库：佣金率换成这次的答复，空值行也补上', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const stable = stableId();
  const key = `tb:${stable}`;
  await seedItem(h, f, pool, key);
  const item = product(f, stable, { commission_rate_bp: 1500n });
  stubProduct(item);

  await success(await addLink(f, pool, linkOf(item.item_id!), bounds(3)));

  expect(await itemRow(h, f, pool, key)).toMatchObject({ commission_rate_bp: 1500, sort: 3 });
});

it('[BR-PRICE-11][BR-PROD-08] 重新上架：复核通过写入这次的佣金率', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const stable = stableId();
  const key = `tb:${stable}`;
  await seedItem(h, f, pool, key, {
    status: 'offline',
    invalid_reason: '联盟返回下架',
    commission_rate_bp: 100,
  });
  await seedRef(h, f, key, { raw_item_id: `rawA-${stable}` });
  union.getItem.mockResolvedValue(product(f, stable, { commission_rate_bp: 1700n }));

  await success(await send(f, 'updateItem', { pool, key }, { status: 'online' }));

  expect(await itemRow(h, f, pool, key)).toMatchObject({
    status: 'online',
    commission_rate_bp: 1700,
  });
});

it('[BR-PROD-05] 刷新挪过 quoted_at 的行重新上架：原串不因 quoted_at 新鲜就用池里的，走 product_refs', async () => {
  const f = await setup(h);
  const { pool, stable, key, raw } = await refreshedOffline(f);
  const fresh = `rawRef-${stable}`;
  await seedRef(h, f, key);
  union.getItem.mockResolvedValue(product(f, stable, { item_id: fresh }));

  await success(await send(f, 'updateItem', { pool, key }, { status: 'online' }));

  expect(usedRaws()).toEqual([fresh]);
  expect(usedRaws()).not.toContain(raw);
});

it('[BR-PROD-05] 刷新挪过 quoted_at 的行重新上架，取不到新鲜原串也搜不到同键：保持 offline，不用池里的原串', async () => {
  const f = await setup(h);
  const { pool, stable, key, raw } = await refreshedOffline(f);
  searchAnswers([[]]);
  // The row's raw ID still reaches this product: misusing it would put the row back online.
  union.getItem.mockResolvedValue(product(f, stable));

  const item = await success(await send(f, 'updateItem', { pool, key }, { status: 'online' }));

  expect(item.status).toBe('offline');
  expect(usedRaws()).not.toContain(raw);
});

it('[BR-PROD-08] 复核没过的重复入库保留原佣金率：答复本身不可信时不写', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const stable = stableId();
  const key = `tb:${stable}`;
  const item = product(f, stable, { commission_rate_bp: 1800n });
  stubProduct(item);
  await success(await addLink(f, pool, linkOf(item.item_id!)));
  expect((await itemRow(h, f, pool, key))?.commission_rate_bp).toBe(1800);

  union.getItem.mockResolvedValue({
    ...item,
    commission_rate_bp: 900n,
    price_status: 'anomaly',
    price_anomaly_reason: 'unknown_promo',
  });
  await addLink(f, pool, linkOf(item.item_id!));

  expect((await itemRow(h, f, pool, key))?.commission_rate_bp).toBe(1800);
});

it('[BR-PROD-05] 联盟明确下架时重复入库保留原佣金率', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const stable = stableId();
  const key = `tb:${stable}`;
  const item = product(f, stable, { commission_rate_bp: 1900n });
  stubProduct(item);
  await success(await addLink(f, pool, linkOf(item.item_id!)));
  expect((await itemRow(h, f, pool, key))?.commission_rate_bp).toBe(1900);

  union.getItem.mockRejectedValue(new UnionError('item_unavailable', 'synthetic gone', 'taobao'));
  await addLink(f, pool, linkOf(item.item_id!));

  expect(await itemRow(h, f, pool, key)).toMatchObject({
    status: 'offline',
    commission_rate_bp: 1900,
  });
});
