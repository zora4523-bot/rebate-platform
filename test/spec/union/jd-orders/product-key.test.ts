import { expect, it, vi } from 'vitest';
import type { JdProductKeyMode } from '../../../../apps/api/src/modules/union/infra/jd/orders.ts';
import { collect, ctx, one, pageAnswer, row, singleRowPages, win, wire } from './kit.ts';

// BR-PROD-03 / 05：商品键模式由 productKeyMode 按 app 给出，每次 listOrders 读一次，缺省 item。
type Read = (appId: string) => Promise<JdProductKeyMode>;

const source = { itemId: 'synthAseg-Bseg', skuId: row().skuId };

it('[AC-B1-04zb#62] 没配 productKeyMode 时按 item：item_id = itemId 全串', async () => {
  expect((await one(row(source))).item_id).toBe('synthAseg-Bseg');
});

it('[AC-B1-04zb#63] item 模式取 itemId 全串，sku 模式取 skuId 字符串', async () => {
  const item = await one(row(source), { productKeyMode: { read: async () => 'item' } });
  expect(item.item_id).toBe('synthAseg-Bseg');
  const sku = await one(row(source), { productKeyMode: { read: async () => 'sku' } });
  expect(sku.item_id).toBe('100012345678');
});

it('[AC-B1-04zb#64] 每次 listOrders 按 ctx.appId 读一次，翻页不多读', async () => {
  const read = vi.fn<Read>(async () => 'item');
  const { pages } = singleRowPages(3);
  const { adapter } = wire(pageAnswer(pages), { productKeyMode: { read } });
  const { calls } = await collect(adapter);
  expect(read).toHaveBeenCalledTimes(calls);
  expect(read.mock.calls.every(([appId]) => appId === ctx.appId)).toBe(true);
});

it('[AC-B1-04zb#65] 模式不缓存：配置改了，下一次 listOrders 就按新模式取', async () => {
  const read = vi.fn<Read>();
  read.mockResolvedValueOnce('item').mockResolvedValueOnce('sku');
  const { adapter } = wire(pageAnswer([[row(source)]]), { productKeyMode: { read } });
  const before = await adapter.listOrders(win, {}, ctx);
  const after = await adapter.listOrders(win, {}, ctx);
  expect(before.items[0]?.item_id).toBe('synthAseg-Bseg');
  expect(after.items[0]?.item_id).toBe('100012345678');
});

it('[AC-B1-04zb#66] 读到其他值 → invalid_dto', async () => {
  const read = vi.fn<Read>(async () => 'spu' as unknown as JdProductKeyMode);
  const { adapter } = wire(pageAnswer([[row(source)]]), { productKeyMode: { read } });
  await expect(adapter.listOrders(win, {}, ctx)).rejects.toMatchObject({
    code: 'invalid_dto',
    platform: 'jd',
  });
});
