// B1-17c: the detail hook (BR-WATCH-19 (1), source_kind detail). getProduct gets the recorder as
// options.priceHistory; an answer is a fresh union return only when markFreshDetail marked it (a
// cache hit is unmarked, a stale entry is marked by markStaleDetail).
import { expect, it, vi } from 'vitest';
import { createCatalogCardEntry } from '../../../../apps/api/src/modules/catalog/application/card-entry.ts';
import {
  getProduct,
  markFreshDetail,
  markStaleDetail,
  type ProductDetailOptions,
} from '../../../../apps/api/src/modules/catalog/detail.ts';
import type { PriceSnapshotRecorder } from '../../../../apps/api/src/modules/catalog/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { PRODUCT_KEY, fixture, item } from '../detail/kit.ts';
import { hangingRecorder, hookRecorder, outcome, textOf, throwingRecorder } from './kit.ts';

/** The detail kit with a deterministic card entry (fixed item_ref, link id per product key). */
function setup() {
  const f = fixture();
  const cards = createCatalogCardEntry({
    clock: f.clock,
    viewerContext: { current: f.current },
    itemRefs: { issue: () => 'synthetic-item-ref' },
    registrar: {
      register: async (input) => ({ linkId: `synthetic-link:${input.ref.productKey}` }),
    },
    sourceLinks: { entrySource: async () => null },
    quoter: { quote: f.quote },
    logger: { warn: vi.fn() },
  });
  const options: ProductDetailOptions = { ...f.options, cards };
  return {
    f,
    get(priceHistory?: PriceSnapshotRecorder) {
      return getProduct(
        { product_key: PRODUCT_KEY },
        priceHistory === undefined ? options : { ...options, priceHistory },
      );
    },
  };
}

it('[AC-B1-17c#6] 详情：联盟新鲜返回交出一条 detail 观测（字段逐项，不含查看者），写入器写入', async () => {
  const s = setup();
  const hook = hookRecorder(s.f.clock);
  s.f.detail.mockImplementation(async () => markFreshDetail(item()));
  const card = await s.get(hook.recorder);
  expect(card).toMatchObject({ product_key: PRODUCT_KEY, final_price_fen: 2990 });
  await hook.recorder.drain();
  expect(hook.observations).toEqual([
    {
      appId: 'synthetic_detail',
      platform: 'taobao',
      productKey: 'tb:synthetic001',
      skuKey: null,
      sourceKind: 'detail',
      outcome: 'ok',
      priceFen: 3990n,
      couponFen: 1000n,
      finalPriceFen: 2990n,
      priceStatus: 'ok',
      inStock: true,
      fresh: true,
      userScoped: false,
      goodsSignPlan: null,
    },
  ]);
  const text = textOf(hook.observations);
  expect(text).not.toContain('synthetic_viewer');
  expect(text).not.toContain('synthetic_device');
  expect(hook.writes.map((row) => [row.productKey, row.sourceKind])).toEqual([
    ['tb:synthetic001', 'detail'],
  ]);
});

it('[AC-B1-17c#7] 详情：缓存命中（未标新鲜）与 stale 结果不落库，只有新鲜返回写入', async () => {
  const s = setup();
  const hook = hookRecorder(s.f.clock);
  s.f.detail.mockImplementationOnce(async () => markFreshDetail(item()));
  await s.get(hook.recorder);
  await hook.recorder.drain();
  expect(hook.writes).toHaveLength(1);
  const handedFresh = hook.observations.length;

  s.f.detail.mockImplementationOnce(async () => item());
  await s.get(hook.recorder);
  s.f.detail.mockImplementationOnce(async () => markStaleDetail(item()));
  await s.get(hook.recorder);
  await hook.recorder.drain();

  expect(hook.writes).toHaveLength(1);
  expect(hook.observations.slice(handedFresh).every((row) => row.fresh === false)).toBe(true);
});

it('[AC-B1-17c#8] 详情：上游失败与价格异常的结果与未装配钩子逐项一致，且都不落库', async () => {
  const runs = [setup(), setup()];
  const hook = hookRecorder(runs[1]!.f.clock);
  const results = [];
  for (const [index, s] of runs.entries()) {
    const recorder = index === 0 ? undefined : hook.recorder;
    s.f.detail.mockImplementationOnce(async () => markFreshDetail(item()));
    const ok = await outcome(() => s.get(recorder));
    s.f.detail.mockRejectedValueOnce(new UnionError('upstream_unavailable', 'synthetic outage'));
    const outage = await outcome(() => s.get(recorder));
    s.f.detail.mockImplementationOnce(async () =>
      markFreshDetail(item({ price_status: 'anomaly' })),
    );
    const priceAnomaly = await outcome(() => s.get(recorder));
    results.push({ ok, outage, priceAnomaly });
  }
  await hook.recorder.drain();
  expect(results[0]).toMatchObject({
    ok: { kind: 'returned' },
    outage: { kind: 'rejected', error: { code: 50401 } },
    priceAnomaly: { kind: 'rejected', error: { code: 50303 } },
  });
  expect(results[1]).toEqual(results[0]);
  expect(hook.writes.map((row) => row.productKey)).toEqual(['tb:synthetic001']);
});

it('[AC-B1-17c#9] 详情：记录器抛错或 record 永不返回时，响应与未装配钩子逐项一致（交出即返回、不 await）', async () => {
  const runs = [setup(), setup(), setup()];
  const throwing = throwingRecorder();
  const hanging = hangingRecorder();
  const recorders = [undefined, throwing.recorder, hanging.recorder];
  const results = [];
  for (const [index, s] of runs.entries()) {
    s.f.detail.mockImplementation(async () => markFreshDetail(item()));
    results.push(await outcome(() => s.get(recorders[index])));
  }
  expect(results[0]).toMatchObject({ kind: 'returned' });
  expect(results[1]).toEqual(results[0]);
  expect(results[2]).toEqual(results[0]);
  expect(throwing.record).toHaveBeenCalledTimes(1);
  expect(hanging.record).toHaveBeenCalledTimes(1);
}, 5000);
