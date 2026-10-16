// B1-17c: the link recognition / rebate lookup hook (BR-WATCH-19 (1), source_kind quote).
// createParsing gets the recorder as options.priceHistory; each hit's union detail (getItem on
// the governed adapter, never cached) is a fresh return. No conversion takes part (转链不写).
import { expect, it } from 'vitest';
import type { PriceSnapshotRecorder } from '../../../../apps/api/src/modules/catalog/index.ts';
import { createParsing } from '../../../../apps/api/src/modules/parsing/index.ts';
import {
  UnionError,
  type CallCtx,
  type ItemRef,
} from '../../../../apps/api/src/modules/union/index.ts';
import { CTX, URL_A, URL_C, URL_D, fixture, item } from '../../parsing/core/kit.ts';
import { byKey, hangingRecorder, hookRecorder, outcome, textOf, throwingRecorder } from './kit.ts';

function run(f: ReturnType<typeof fixture>, text: string, priceHistory?: PriceSnapshotRecorder) {
  const options = priceHistory === undefined ? f.options : { ...f.options, priceHistory };
  return createParsing(options).parseInput(text, CTX);
}

it('[AC-B1-17c#10] 链接识别：联盟详情返回交出一条 quote 观测（字段逐项，不含查看者与请求号），写入器写入，不转链', async () => {
  const f = fixture();
  const hook = hookRecorder(f.options.clock);
  const results = await run(f, URL_A, hook.recorder);
  expect(results).toMatchObject([{ kind: 'card' }]);
  await hook.recorder.drain();
  expect(hook.observations).toEqual([
    {
      appId: 'synthetic-app',
      platform: 'taobao',
      productKey: 'tb:a',
      skuKey: null,
      sourceKind: 'quote',
      outcome: 'ok',
      priceFen: 12000n,
      couponFen: 2000n,
      finalPriceFen: 10000n,
      priceStatus: 'ok',
      inStock: true,
      fresh: true,
      userScoped: false,
      goodsSignPlan: null,
    },
  ]);
  const text = textOf(hook.observations);
  expect(text).not.toContain('synthetic-user');
  expect(text).not.toContain('synthetic-device');
  expect(text).not.toContain('synthetic-request');
  expect(text).not.toContain('other_pid');
  expect(hook.writes.map((row) => [row.productKey, row.sourceKind])).toEqual([['tb:a', 'quote']]);
  expect(f.convert).not.toHaveBeenCalled();
});

it('[AC-B1-17c#11] 链接识别：一条消息多个命中，下架失败与拼多多不落库，结果与未装配钩子逐项一致', async () => {
  const runs = [fixture(), fixture()];
  const hook = hookRecorder(runs[1]!.options.clock);
  const text = `${URL_A} ${URL_C} ${URL_D}`;
  const results = [];
  for (const [index, f] of runs.entries()) {
    f.getItem.mockImplementation(async (ref: ItemRef, context: CallCtx) => {
      void context;
      if (ref.platform === 'taobao' && ref.item_id === 'synthetic-prefix-d') {
        throw new UnionError('item_unavailable', 'synthetic delisted');
      }
      return item(ref);
    });
    results.push(await outcome(() => run(f, text, index === 0 ? undefined : hook.recorder)));
  }
  await hook.recorder.drain();
  expect(results[0]).toMatchObject({
    kind: 'returned',
    value: [{ kind: 'card' }, { kind: 'card' }, { kind: 'error', error_code: 30141 }],
  });
  expect(results[1]).toEqual(results[0]);
  expect(hook.writes.map((row) => [row.productKey, row.sourceKind])).toEqual([['tb:a', 'quote']]);
  expect(
    byKey(hook.observations)
      .filter((row) => row.platform === 'pdd')
      .map((row) => [row.productKey, row.goodsSignPlan, row.userScoped]),
  ).toEqual([['pdd:c', null, false]]);
});

it('[AC-B1-17c#12] 链接识别：价格异常命中不落库，同消息正常命中照写', async () => {
  const f = fixture();
  const hook = hookRecorder(f.options.clock);
  f.getItem.mockImplementation(async (ref: ItemRef, context: CallCtx) => {
    void context;
    if (ref.platform === 'taobao' && ref.item_id === 'synthetic-prefix-a') {
      return item(ref, { price_status: 'anomaly' });
    }
    return item(ref);
  });
  const results = await run(f, `${URL_A} ${URL_D}`, hook.recorder);
  expect(results).toMatchObject([{ kind: 'price_unavailable' }, { kind: 'card' }]);
  await hook.recorder.drain();
  expect(hook.writes.map((row) => [row.productKey, row.sourceKind])).toEqual([['tb:d', 'quote']]);
});

it('[AC-B1-17c#13] 链接识别：记录器抛错或 record 永不返回时，结果与未装配钩子逐项一致（交出即返回、不 await）', async () => {
  const runs = [fixture(), fixture(), fixture()];
  const throwing = throwingRecorder();
  const hanging = hangingRecorder();
  const recorders = [undefined, throwing.recorder, hanging.recorder];
  const text = `${URL_A} ${URL_D}`;
  const results = [];
  for (const [index, f] of runs.entries()) {
    results.push(await outcome(() => run(f, text, recorders[index])));
  }
  expect(results[0]).toMatchObject({
    kind: 'returned',
    value: [{ kind: 'card' }, { kind: 'card' }],
  });
  expect(results[1]).toEqual(results[0]);
  expect(results[2]).toEqual(results[0]);
  expect(throwing.record).toHaveBeenCalledTimes(2);
  expect(hanging.record).toHaveBeenCalledTimes(2);
}, 5000);
