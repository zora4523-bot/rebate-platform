import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  answer,
  close,
  fixture,
  invariant,
  open,
  rows,
  state,
  TIMEOUT,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-05d#42] out_biz_no 真实唯一冲突后重生成，事务仍可冻结且不写重复凭证', async () => {
  const f = await fixture(h);
  const duplicate = 'WAAAAAAAAAAAAAAAAAAAA';
  const fresh = 'WBBBBBBBBBBBBBBBBBBBB';
  f.options.outBizNo = () => duplicate;
  expect(answer(await f.request()).code).toBe(0);
  let calls = 0;
  f.options.outBizNo = () => {
    calls += 1;
    return calls <= 2 ? duplicate : fresh;
  };
  expect(answer(await f.request()).code).toBe(0);
  expect(calls).toBe(3);
  expect((await rows(f)).map((r) => r.out_biz_no).sort()).toEqual([duplicate, fresh]);
  expect((await state(f)).vouchers).toHaveLength(2);
  await invariant(f);
});

it('[AC-B2-05d#43] 连续唯一冲突最多重生成三次，失败后无新单、凭证、事件、幂等结果', async () => {
  const f = await fixture(h);
  f.options.outBizNo = () => 'WAAAAAAAAAAAAAAAAAAAA';
  expect(answer(await f.request()).code).toBe(0);
  let calls = 0;
  f.options.outBizNo = () => {
    calls += 1;
    return 'WAAAAAAAAAAAAAAAAAAAA';
  };
  const before = await state(f);
  await expect(f.request()).rejects.toBeDefined();
  // Initial candidate plus no more than three regenerated candidates.
  expect(calls).toBeGreaterThanOrEqual(3);
  expect(calls).toBeLessThanOrEqual(4);
  expect(await state(f)).toEqual(before);
});
