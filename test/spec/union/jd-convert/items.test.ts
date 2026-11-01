import { expect, it, vi } from 'vitest';
import { UnionError, type ItemRef } from '../../../../apps/api/src/modules/union/domain/types.ts';
import type { JdProductKeyMode } from '../../../../apps/api/src/modules/union/infra/jd/orders.ts';
import { unionFailure } from '../jd-core/kit.ts';
import {
  clickUrl,
  ctx,
  expectNothingSent,
  firstBody,
  identity,
  itemId,
  materialId,
  modePort,
  req,
  skuId,
  wire,
} from './kit.ts';

// sku 模式存的是 skuId，官方只接受完整联盟商品 ID（2001707），换不了，不发请求、不猜。
const skuModeRefs: readonly (readonly [string, ItemRef])[] = [
  ['item_id 是 skuId', { platform: 'jd', item_id: skuId }],
  ['skuId', { platform: 'jd', skuId }],
  ['itemId 是 skuId', { platform: 'jd', itemId: skuId }],
  ['联盟 itemId', { platform: 'jd', item_id: itemId }],
];

const badItems: readonly (readonly [string, ItemRef])[] = [
  ['空串', { platform: 'jd', item_id: '' }],
  ['含斜杠', { platform: 'jd', item_id: 'synthA/Bseg' }],
  ['含问号', { platform: 'jd', item_id: 'synthA?Bseg' }],
  ['含空格', { platform: 'jd', item_id: 'synthA Bseg' }],
  ['含制表符', { platform: 'jd', item_id: 'synthA\tBseg' }],
  ['含换行', { platform: 'jd', item_id: 'synthA\nBseg' }],
  ['含全角空格', { platform: 'jd', item_id: 'synthA　Bseg' }],
  ['只有空白', { platform: 'jd', item_id: ' ' }],
  ['null', { platform: 'jd', item_id: null }],
  ['没有商品键', { platform: 'jd' }],
];

it.each(skuModeRefs)(
  '[AC-B1-04zd#14] sku 模式 %s → link_unrecognized，不取凭据、不发请求',
  async (_name, item) => {
    const productKeyMode = modePort('sku');
    const h = wire(undefined, { productKeyMode });
    await unionFailure(
      () => h.adapter.convert({ ...req, item }, identity, ctx),
      'link_unrecognized',
    );
    expectNothingSent(h);
    expect(productKeyMode.read).toHaveBeenCalledExactlyOnceWith(ctx.appId);
  },
);

it('[AC-B1-04zd#15] 商品键模式每次转链按 ctx.appId 读一次，不缓存', async () => {
  const productKeyMode = modePort('item');
  const h = wire(undefined, { productKeyMode });
  await h.adapter.convert(req, identity, ctx);
  await h.adapter.convert(req, identity, ctx);
  expect(h.transport).toHaveBeenCalledTimes(2);
  expect(productKeyMode.read.mock.calls).toEqual([[ctx.appId], [ctx.appId]]);
});

it.each(badItems)(
  '[AC-B1-04zd#16] item 模式商品键%s → invalid_dto，不取凭据、不发请求',
  async (_name, item) => {
    const h = wire();
    await unionFailure(() => h.adapter.convert({ ...req, item }, identity, ctx), 'invalid_dto');
    expectNothingSent(h);
  },
);

// linking 的 itemRefOf 把链接存的原串放在 itemId（同 getItem 的取法）。
it('[AC-B1-04zd#17] linking 只给 itemId 时照常转链：item 模式下它就是联盟 itemId', async () => {
  const h = wire();
  const result = await h.adapter.convert(
    { ...req, item: { platform: 'jd', itemId } },
    identity,
    ctx,
  );
  expect(result).toEqual({ kind: 'url', url: clickUrl });
  expect(firstBody(h)['materialId']).toBe(materialId);
});

it('[AC-B1-04zd#18] item_id 与 itemId 都有时用 item_id', async () => {
  const h = wire();
  await h.adapter.convert(
    { ...req, item: { platform: 'jd', item_id: itemId, itemId: 'otherAseg_Oseg' } },
    identity,
    ctx,
  );
  expect(firstBody(h)['materialId']).toBe(materialId);
});

it('[AC-B1-04zd#19] 商品键模式读失败不退回 item：错误原样抛出，不取凭据、不发请求', async () => {
  const read = vi.fn(async (): Promise<JdProductKeyMode> => {
    throw new UnionError('upstream_unavailable', 'synthetic read failure', 'jd');
  });
  const h = wire(undefined, { productKeyMode: { read } });
  await unionFailure(() => h.adapter.convert(req, identity, ctx), 'upstream_unavailable');
  expectNothingSent(h);
});

it('[AC-B1-04zd#20] 商品键模式读到 sku、item 以外的值 → invalid_dto，不发请求', async () => {
  const read = vi.fn(async () => 'bogus' as unknown as JdProductKeyMode);
  const h = wire(undefined, { productKeyMode: { read } });
  await unionFailure(() => h.adapter.convert(req, identity, ctx), 'invalid_dto');
  expectNothingSent(h);
});
