import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
// Through the module's only public exit (apps/api AGENTS.md: cross-module imports use index.ts).
import { createWithdrawalNotificationReader } from '../../../../apps/api/src/modules/payout/index.ts';
import {
  ACCOUNT_PLAIN,
  BANK_NAME,
  PAYEE_NAME,
  PRIVATE_KEYS,
  TIMEOUT,
  VIEW_KEYS,
  close,
  expectedView,
  footprint,
  member,
  open,
  seedWithdrawal,
  serialise,
  type Harness,
} from './kit.ts';

// Real PostgreSQL (the global setup provisions it), run only in the orchestrator's isolated container.
// The reader is created inside each test, so a skeleton fails per test with NotImplemented.
let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

const PAID_AT = new Date('2026-10-19T08:09:10.123Z');
const CREATED_AT = new Date('2026-10-17T22:33:44.555Z');

const STATES = [
  { name: 'PENDING_REVIEW', patch: { status: 'PENDING_REVIEW', payout_channel: 'alipay' } },
  {
    name: 'APPROVED',
    patch: {
      status: 'APPROVED',
      payout_channel: 'bank_card',
      review_mode: 'manual',
      reviewer_id: randomUUID(),
      reviewed_at: new Date('2026-10-18T05:00:00.000Z'),
    },
  },
  {
    name: 'REJECTED',
    patch: { status: 'REJECTED', payout_channel: 'alipay', reject_reason_code: 'RISK_SUSPECT' },
  },
  { name: 'PAYING', patch: { status: 'PAYING', payout_channel: 'wechat' } },
  {
    name: 'PAID_API',
    patch: { status: 'PAID_API', payout_channel: 'alipay', paid_at: PAID_AT },
  },
  {
    name: 'PAID_MANUAL',
    patch: { status: 'PAID_MANUAL', payout_channel: 'bank_card', paid_at: PAID_AT },
  },
  {
    name: 'FAILED',
    patch: { status: 'FAILED', payout_channel: 'alipay', fail_code: 'PAYEE_NOT_EXIST' },
  },
] as const;

it.each(STATES)(
  '[AC-B2-05l#1] $name 单逐字段精确等于库行（金额 bigint 分、时间 Date、按 id 取同 app 同用户的那一张）',
  async ({ patch }) => {
    const reader = createWithdrawalNotificationReader();
    const who = await member(h.db);
    // A sibling of the same user with other values: the port must key on the withdrawal id.
    const sibling = await seedWithdrawal(h.db, who, {
      status: 'PAID_API',
      paid_at: new Date('2026-10-01T00:00:00.000Z'),
      amount_fen: 999_00n,
      fee_fen: 0n,
      tax_fen: 0n,
    });
    const row = await seedWithdrawal(h.db, who, {
      ...patch,
      amount_fen: 98_765n,
      fee_fen: 987n,
      tax_fen: 321n,
      created_at: CREATED_AT,
    });
    expect(row.net_fen).toBe(98_765n - 987n - 321n);
    const view = await reader.read(h.db, { appId: who.appId, withdrawalId: row.id });
    expect(view).toStrictEqual(expectedView(row));
    expect(view).toMatchObject({
      withdrawal_id: row.id,
      user_id: who.userId,
      status: patch.status,
      payout_channel: patch.payout_channel,
      created_at: CREATED_AT,
      amount_fen: 98_765n,
      fee_fen: 987n,
      tax_fen: 321n,
      net_fen: 97_457n,
    });
    expect(typeof view!.amount_fen).toBe('bigint');
    expect(typeof view!.net_fen).toBe('bigint');
    expect(typeof view!.fee_fen).toBe('bigint');
    expect(typeof view!.tax_fen).toBe('bigint');
    expect(view!.created_at).toBeInstanceOf(Date);
    if (patch.status === 'PAID_API' || patch.status === 'PAID_MANUAL') {
      expect(view!.paid_at).toBeInstanceOf(Date);
      expect(view!.paid_at!.toISOString()).toBe(PAID_AT.toISOString());
    } else {
      expect(view!.paid_at).toBeNull();
    }
    expect(view!.fail_code).toBe(patch.status === 'FAILED' ? 'PAYEE_NOT_EXIST' : null);
    expect(view!.reject_reason_code).toBe(patch.status === 'REJECTED' ? 'RISK_SUSPECT' : null);
    const other = await reader.read(h.db, { appId: who.appId, withdrawalId: sibling.id });
    expect(other).toStrictEqual(expectedView(sibling));
  },
  TIMEOUT,
);

it.each([
  'NEGATIVE_BALANCE',
  'RISK_SUSPECT',
  'ORDER_ABNORMAL',
  'PAYEE_INFO_INVALID',
  'USER_REQUEST',
  'OTHER',
] as const)(
  '[AC-B2-05l#2] REJECTED 原因码 %s 原样返回（WD_REJECTED 选句依据），内部备注不出端口',
  async (code) => {
    const reader = createWithdrawalNotificationReader();
    const who = await member(h.db);
    const row = await seedWithdrawal(h.db, who, {
      status: 'REJECTED',
      reject_reason_code: code,
      reject_note: '仅内部可见的合成备注',
      blocked_reason: code === 'NEGATIVE_BALANCE' ? 'NEGATIVE_BALANCE' : null,
      review_mode: 'manual',
      reviewed_at: new Date('2026-10-18T06:00:00.000Z'),
    });
    const view = await reader.read(h.db, { appId: who.appId, withdrawalId: row.id });
    expect(view).toStrictEqual(expectedView(row));
    expect(view!.status).toBe('REJECTED');
    expect(view!.reject_reason_code).toBe(code);
    expect(serialise(view)).not.toContain('仅内部可见的合成备注');
  },
  TIMEOUT,
);

it(
  '[AC-B2-05l#3] 别 app 用同一 id 取 → null；不存在的 id → null；本 app 取别 app 的单 → null',
  async () => {
    const reader = createWithdrawalNotificationReader();
    const mine = await member(h.db);
    const theirs = await member(h.db);
    const own = await seedWithdrawal(h.db, mine, { status: 'REJECTED' });
    const foreign = await seedWithdrawal(h.db, theirs, { status: 'REJECTED' });
    await expect(
      reader.read(h.db, { appId: theirs.appId, withdrawalId: own.id }),
    ).resolves.toBeNull();
    await expect(
      reader.read(h.db, { appId: mine.appId, withdrawalId: foreign.id }),
    ).resolves.toBeNull();
    await expect(
      reader.read(h.db, { appId: mine.appId, withdrawalId: randomUUID() }),
    ).resolves.toBeNull();
    await expect(
      reader.read(h.db, { appId: `rp_absent_${randomUUID()}`, withdrawalId: own.id }),
    ).resolves.toBeNull();
    // The same ids still resolve in their own app: the nulls above are the app filter.
    await expect(
      reader.read(h.db, { appId: mine.appId, withdrawalId: own.id }),
    ).resolves.toStrictEqual(expectedView(own));
    await expect(
      reader.read(h.db, { appId: theirs.appId, withdrawalId: foreign.id }),
    ).resolves.toStrictEqual(expectedView(foreign));
  },
  TIMEOUT,
);

it(
  '[AC-B2-05l#4] 在调用方句柄上读：事务内看得到本事务未提交的单，别的连接看不到',
  async () => {
    const reader = createWithdrawalNotificationReader();
    const who = await member(h.db);
    await h.db.transaction().execute(async (trx) => {
      const row = await seedWithdrawal(trx, who, { status: 'PENDING_REVIEW' });
      await expect(
        reader.read(trx, { appId: who.appId, withdrawalId: row.id }),
      ).resolves.toStrictEqual(expectedView(row));
      await expect(
        reader.read(h.observer, { appId: who.appId, withdrawalId: row.id }),
      ).resolves.toBeNull();
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-05l#5] 端口不改任何行：只读事务里可读，调用前后提现行（含 row_version、updated_at）、分录、事件、冻结记录不变',
  async () => {
    const reader = createWithdrawalNotificationReader();
    const who = await member(h.db);
    const rows = [
      await seedWithdrawal(h.db, who, { status: 'PENDING_REVIEW', row_version: 0 }),
      await seedWithdrawal(h.db, who, {
        status: 'REJECTED',
        reject_reason_code: 'NEGATIVE_BALANCE',
        blocked_reason: 'NEGATIVE_BALANCE',
        row_version: 3,
      }),
      await seedWithdrawal(h.db, who, {
        status: 'FAILED',
        fail_code: 'PAYEE_NOT_EXIST',
        row_version: 5,
      }),
    ];
    const before = await footprint(h.db, who.appId);
    expect(before.withdrawals).toHaveLength(3);
    // Any INSERT / UPDATE / DELETE (or nextval) inside a READ ONLY transaction raises 25006.
    const views = await h.db.transaction().execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      const out: unknown[] = [];
      for (const row of rows) {
        out.push(await reader.read(trx, { appId: who.appId, withdrawalId: row.id }));
      }
      return out;
    });
    expect(views).toStrictEqual(rows.map(expectedView));
    // And on a plain connection, read twice.
    for (const row of rows) {
      await reader.read(h.db, { appId: who.appId, withdrawalId: row.id });
      await reader.read(h.db, { appId: who.appId, withdrawalId: row.id });
    }
    const after = await footprint(h.db, who.appId);
    expect(after).toStrictEqual(before);
    expect(Object.fromEntries(after.withdrawals.map((row) => [row.id, row.row_version]))).toEqual({
      [rows[0]!.id]: 0,
      [rows[1]!.id]: 3,
      [rows[2]!.id]: 5,
    });
    expect(after.vouchers).toEqual([]);
    expect(after.entries).toEqual([]);
  },
  TIMEOUT,
);

it.each(['alipay', 'bank_card', 'wechat'] as const)(
  '[AC-B2-05l#6] %s 单的返回对象键集合精确为 12 个，不含姓名、账号密文、HMAC、银行名等个人信息',
  async (channel) => {
    const reader = createWithdrawalNotificationReader();
    const who = await member(h.db);
    const row = await seedWithdrawal(h.db, who, {
      status: 'PAID_API',
      paid_at: PAID_AT,
      payout_channel: channel,
    });
    const view = await reader.read(h.db, { appId: who.appId, withdrawalId: row.id });
    expect(view).not.toBeNull();
    expect(Object.keys(view!).sort()).toEqual([...VIEW_KEYS]);
    for (const key of PRIVATE_KEYS) expect(view).not.toHaveProperty(key);
    const text = serialise(view);
    for (const secret of [PAYEE_NAME, BANK_NAME, ACCOUNT_PLAIN, row.payee_hmac, 'cipher:']) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain(row.out_biz_no);
  },
  TIMEOUT,
);
