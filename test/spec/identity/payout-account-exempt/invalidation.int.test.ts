// B2-05j rule tests: identity's createPayoutAccountInvalidation (exported by identity/index.ts) for
// admin B1-27g's realname correction (BR-WDR-02 细则「实名更正后的失效与重绑」: 该用户的收款账号
// 全部失效，这次失效不计入每月变更次数; 04 §3.2 limit_exempt_reason). Real PG through the B1-13e
// kit; the caller's transaction holds the users row lock first. Top-level it() only.
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { NOW, account, close, fixture, open, state, type Kit } from '../payout-account/kit.ts';
import { EXEMPT, OPERATOR, invalidate, invalidation, lockUser } from './kit.ts';

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

/** The command's time, distinct from the injected Clock: the port stamps the caller's `now`. */
const AT = new Date('2026-10-18T04:05:06.789Z');

it('[AC-B2-05j#3] 一个支付宝当前行：置 is_current=false、row_version+1、updated_at=now，写一条 exempt 变更行，返回 {retired:1}', async () => {
  const f = await fixture(kit);
  const before = await account(kit, f);
  expect(await invalidate(kit, f, AT)).toEqual({ retired: 1 });
  const rows = await state(kit, f);
  expect(rows.accounts).toEqual([
    { ...before, is_current: false, row_version: before.row_version + 1, updated_at: AT },
  ]);
  expect(rows.changes).toHaveLength(1);
  expect(rows.changes[0]).toMatchObject({
    app_id: f.appId,
    user_id: f.uid,
    old_payout_method: 'alipay',
    old_hmac: before.alipay_hmac,
    new_payout_method: 'alipay',
    new_hmac: '',
    operator: OPERATOR,
    changed_at: AT,
    limit_exempt_reason: EXEMPT,
  });
});

it('[AC-B2-05j#4] 银行卡当前行失效：old_hmac 取 bank_card_hmac、new_payout_method 仍为 bank_card；历史行与同 App 他人的当前行不动', async () => {
  const f = await fixture(kit);
  const other = await fixture(kit, { appId: f.appId });
  const history = await account(kit, f, 'old@example.com', { current: false });
  const before = await account(kit, f, '6222021234567890123', { method: 'bank_card' });
  await account(kit, other, 'other@example.com');
  const othersBefore = await state(kit, other);
  const operator = 'admin:2002';
  expect(await invalidate(kit, f, AT, operator)).toEqual({ retired: 1 });
  const rows = await state(kit, f);
  expect(rows.accounts).toHaveLength(2);
  expect(rows.accounts.find((row) => row.id === history.id)).toEqual(history);
  expect(rows.accounts.find((row) => row.id === before.id)).toEqual({
    ...before,
    is_current: false,
    row_version: before.row_version + 1,
    updated_at: AT,
  });
  expect(rows.changes).toHaveLength(1);
  expect(rows.changes[0]).toMatchObject({
    app_id: f.appId,
    user_id: f.uid,
    old_payout_method: 'bank_card',
    old_hmac: before.bank_card_hmac,
    new_payout_method: 'bank_card',
    new_hmac: '',
    operator,
    changed_at: AT,
    limit_exempt_reason: EXEMPT,
  });
  expect(await state(kit, other)).toEqual(othersBefore);
});

it('[AC-B2-05j#5] 无当前行（从未绑定，或只剩历史行）：返回 {retired:0}，零写入', async () => {
  const never = await fixture(kit);
  expect(await invalidate(kit, never, AT)).toEqual({ retired: 0 });
  expect(await state(kit, never)).toEqual({ accounts: [], changes: [] });

  const retired = await fixture(kit);
  await account(kit, retired, 'old@example.com', { current: false });
  const before = await state(kit, retired);
  expect(await invalidate(kit, retired, AT)).toEqual({ retired: 0 });
  expect(await state(kit, retired)).toEqual(before);
});

it('[AC-B2-05j#6] 失效加入调用方事务：提交前外部不可见，调用方失败整笔回滚', async () => {
  const f = await fixture(kit);
  await account(kit, f);
  const before = await state(kit, f);
  const port = await invalidation();
  const rollback = new Error('fixture caller rollback');
  await expect(
    kit.db.transaction().execute(async (trx) => {
      await lockUser(trx, f);
      expect(
        await port.invalidate(trx, { appId: f.appId, userId: f.uid, operator: OPERATOR, now: AT }),
      ).toEqual({ retired: 1 });
      const inside = await state(kit, f, trx);
      expect(inside.accounts.filter((row) => row.is_current)).toEqual([]);
      expect(inside.changes).toHaveLength(1);
      expect(await state(kit, f)).toEqual(before);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await state(kit, f)).toEqual(before);
});
