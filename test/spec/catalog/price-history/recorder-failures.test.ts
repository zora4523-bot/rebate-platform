// B1-17b: repeated write failures on one recorder accumulate (BR-WATCH-19 (1): 写入失败只计数不重试;
// orchestrator semantics B.4). Exception round 3 (review r2 S1): a recorder that assigns 1 on every
// failure instead of adding 1 must fail here. A fake store stands in for the database.
import { expect, it } from 'vitest';
import {
  createPriceSnapshotRecorder,
  type PriceSnapshotWriteOutcome,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { fakeStore, observation, recorderSetup, settle } from './kit.ts';

it('[AC-B1-17b#50] 同一记录器连续写库失败逐次累加（1、2），成功与拒写不重置，再失败到 3；每次可写观测只尝试一次、每次失败一条 warn', async () => {
  // Store script per call: reject, reject, succeed, throw synchronously.
  let calls = 0;
  const { store, write } = fakeStore((): Promise<PriceSnapshotWriteOutcome> => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error('connection refused'));
    if (calls === 2) return Promise.reject(new Error('connection refused'));
    if (calls === 3) return Promise.resolve<PriceSnapshotWriteOutcome>('inserted');
    throw new Error('pool ended');
  });
  const { options, warn } = recorderSetup({ store });
  const recorder = createPriceSnapshotRecorder(options);

  const step = async (fen: bigint, extra: Parameters<typeof observation>[0] = {}) => {
    expect(() =>
      recorder.record(observation({ priceFen: fen, finalPriceFen: fen, ...extra })),
    ).not.toThrow();
    await expect(recorder.drain()).resolves.toBeUndefined();
    await settle(20);
    await recorder.drain();
  };

  // 1st failure.
  await step(4500n);
  expect(write).toHaveBeenCalledTimes(1);
  expect(recorder.failureCount()).toBe(1);
  expect(warn).toHaveBeenCalledTimes(1);

  // 2nd failure on the same recorder: the count adds up to 2.
  await step(3900n);
  expect(write).toHaveBeenCalledTimes(2);
  expect(recorder.failureCount()).toBe(2);
  expect(warn).toHaveBeenCalledTimes(2);

  // A successful write does not reset the count.
  await step(3500n);
  expect(write).toHaveBeenCalledTimes(3);
  expect(recorder.failureCount()).toBe(2);
  expect(warn).toHaveBeenCalledTimes(2);

  // A refused observation (not writable) is not handed to the store and does not reset the count.
  await step(3400n, { outcome: 'failed' });
  expect(write).toHaveBeenCalledTimes(3);
  expect(recorder.failureCount()).toBe(2);
  expect(warn).toHaveBeenCalledTimes(2);

  // 3rd failure (store throws synchronously): the count goes on to 3.
  await step(3300n);
  expect(write).toHaveBeenCalledTimes(4);
  expect(recorder.failureCount()).toBe(3);
  expect(warn).toHaveBeenCalledTimes(3);
  for (const call of warn.mock.calls) {
    expect(call[0]).toMatchObject({ code: 'PRICE_SNAPSHOT_WRITE_FAILED' });
  }
}, 10_000);
