// B2-05j rule tests: the monthly change count leaves out limit_exempt_reason rows, and the first
// rebinding after a realname-correction invalidation is not counted (BR-WDR-02 细则「实名更正后的
// 失效与重绑」, 04 §3.2). Real AppModule + PG + Redis through the B1-13e kit; top-level it() only.
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  ALIPAY_CONTEXT,
  LOGIN,
  NOW,
  account,
  change,
  close,
  config,
  envelope,
  fixture,
  open,
  save,
  state,
  type Kit,
} from '../payout-account/kit.ts';
import { EXEMPT, exemptChange, exemptColumn, exemptReasons, invalidate } from './kit.ts';

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
});
beforeEach(() => {
  kit.clock.set(NOW);
  kit.lines.length = 0;
});
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await redis?.stop();
    } finally {
      await database?.drop();
    }
  }
});

const LIMIT = { code: 30303, data: { reason: 'payout_account_change_limit' } };

it('[AC-B2-05j#1] 本月 2 条变更其中 1 条 exempt：GET 剩余 = 上限 − 1；换绑一次后剩 0，再换绑 30303', async () => {
  const f = await fixture(kit);
  await exemptColumn(kit);
  await account(kit, f, 'old@example.com');
  await change(kit, f);
  await exemptChange(kit, f);
  expect(envelope(kit, await f.get())).toMatchObject({ change_remaining_this_month: 1 });
  expect(await save(kit, f)).toMatchObject({ code: 0, data: { change_remaining_this_month: 0 } });
  expect(envelope(kit, await f.get())).toMatchObject({ change_remaining_this_month: 0 });
  expect(await save(kit, f, { alipayLogonId: 'third@example.com' })).toEqual(LIMIT);
  expect(await exemptReasons(kit, f)).toEqual([null, EXEMPT, null]);
});

it('[AC-B2-05j#2] exempt 行不论几条都不占名额：配置上限 1、本月 3 条 exempt → 剩 1，换绑后剩 0，再换绑 30303', async () => {
  const f = await fixture(kit);
  await exemptColumn(kit);
  await config(kit, f, 'withdraw.payout_account_change_per_month', 1);
  await account(kit, f, 'old@example.com');
  for (let i = 0; i < 3; i++) await exemptChange(kit, f);
  expect(envelope(kit, await f.get())).toMatchObject({ change_remaining_this_month: 1 });
  expect(await save(kit, f)).toMatchObject({ code: 0, data: { change_remaining_this_month: 0 } });
  expect(await save(kit, f, { alipayLogonId: 'third@example.com' })).toEqual(LIMIT);
  expect((await state(kit, f)).changes).toHaveLength(4);
});

it('[AC-B2-05j#7] 失效后首次重绑走首绑：不写变更行、剩余不变；之后再换绑才计次，额满 30303', async () => {
  const f = await fixture(kit);
  const old = await account(kit, f);
  await change(kit, f);
  expect(envelope(kit, await f.get())).toMatchObject({ change_remaining_this_month: 1 });

  expect(await invalidate(kit, f, kit.clock.now())).toEqual({ retired: 1 });
  expect(envelope(kit, await f.get())).toEqual({});
  const invalidated = await state(kit, f);
  expect(invalidated.accounts.filter((row) => row.is_current)).toEqual([]);
  expect(invalidated.changes).toHaveLength(2);
  expect(await exemptReasons(kit, f)).toEqual([null, EXEMPT]);

  // The first rebinding (here the same account again) is a first binding: no change row.
  const rebound = await save(kit, f);
  expect(rebound).toMatchObject({ code: 0, data: { change_remaining_this_month: 1 } });
  const afterRebind = await state(kit, f);
  expect(afterRebind.changes).toEqual(invalidated.changes);
  const current = afterRebind.accounts.filter((row) => row.is_current);
  expect(current).toHaveLength(1);
  expect(current[0]!.id).not.toBe(old.id);
  expect(rebound).toMatchObject({ data: { payout_account_id: current[0]!.id } });
  expect(envelope(kit, await f.get())).toMatchObject({ change_remaining_this_month: 1 });

  // The next change is an ordinary one and counts.
  expect(await save(kit, f, { alipayLogonId: 'next@example.com' })).toMatchObject({
    code: 0,
    data: { change_remaining_this_month: 0 },
  });
  const changed = await state(kit, f);
  expect(changed.changes).toHaveLength(3);
  expect(changed.changes[2]).toMatchObject({
    old_payout_method: 'alipay',
    old_hmac: kit.crypto.blindIndex(LOGIN, ALIPAY_CONTEXT),
    new_payout_method: 'alipay',
    new_hmac: kit.crypto.blindIndex('next@example.com', ALIPAY_CONTEXT),
  });
  expect(await exemptReasons(kit, f)).toEqual([null, EXEMPT, null]);
  expect(await save(kit, f, { alipayLogonId: 'last@example.com' })).toEqual(LIMIT);
});
