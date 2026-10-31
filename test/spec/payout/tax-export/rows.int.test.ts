// B2-08d (规划/08 BR-WDR-21 涉税导出与报送; task §9.1 / §9.3): which withdrawals the quarterly tax
// export lists and what each row carries. Real PostgreSQL (the global setup provisions it), run
// only in the orchestrator's isolated container. The reader is created inside each test before
// anything is seeded, so a skeleton fails per test with NotImplemented.
//   范围   status PAID_API / PAID_MANUAL and paid_at ∈ [quarter start, next quarter start) at +08:00
//          (by paid_at, not created_at); one app only;
//   字段   withdrawal_id, user_id, income_type, amount_fen (收入额 = the application amount, not
//          net), tax_fen, paid_at, masked_account (the row's own snapshot, decrypted with the port
//          and masked), out_biz_no, payout_channel — and nothing else: no payee name, account in
//          clear, cipher or HMAC;
//   只读   plain SELECTs on the caller's handle.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
// Through the module's only public exit (apps/api AGENTS.md: cross-module imports use index.ts).
import { createTaxExportReader } from '../../../../apps/api/src/modules/payout/index.ts';
import {
  ALIPAY_EMAIL,
  ALIPAY_EMAIL_MASKED,
  ALIPAY_PHONE,
  ALIPAY_PHONE_MASKED,
  BANK_CARD,
  BANK_CARD_MASKED,
  BANK_NAME,
  PAYEE_NAME,
  ROW_KEYS,
  SERVICE_FEE,
  TIMEOUT,
  WECHAT_MASKED,
  WECHAT_OPENID,
  close,
  expectedRow,
  fakeDecrypt,
  footprint,
  ids,
  inExportOrder,
  member,
  open,
  seedUser,
  seedWithdrawal,
  serialise,
  type Harness,
  type WithdrawalRow,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

/** An instant written at +08:00. */
function cst(text: string): Date {
  return new Date(`${text}+08:00`);
}

function idsOf(rows: readonly WithdrawalRow[]): string[] {
  return inExportOrder(rows).map((row) => row.id);
}

it(
  '[AC-B2-08d#1] Q1 / Q2 边界：3-31 23:59:59.999 +08:00 到账在 Q1，4-1 00:00 +08:00 在 Q2；1-1 00:30 +08:00（UTC 仍是前一年 12-31）在当年 Q1；前一年 12-31 23:59:59.999 +08:00 不在 Q1',
  async () => {
    const decrypt = fakeDecrypt();
    const read = createTaxExportReader({ decrypt: decrypt.decrypt });
    const who = await member(h.db);
    const at = {
      q1Start: cst('2026-01-01T00:00:00.000'),
      q1EarlyUtcPrevYear: cst('2026-01-01T00:30:00.000'),
      q1End: cst('2026-03-31T23:59:59.999'),
      q2Start: cst('2026-04-01T00:00:00.000'),
      q2End: cst('2026-06-30T23:59:59.999'),
      q3Start: cst('2026-07-01T00:00:00.000'),
      before: cst('2025-12-31T23:59:59.999'),
    };
    expect(at.q1EarlyUtcPrevYear.getUTCFullYear()).toBe(2025);
    const rows: Record<keyof typeof at, WithdrawalRow> = {
      q1Start: await seedWithdrawal(h.db, who, { paid_at: at.q1Start }),
      q1EarlyUtcPrevYear: await seedWithdrawal(h.db, who, {
        status: 'PAID_MANUAL',
        paid_at: at.q1EarlyUtcPrevYear,
      }),
      q1End: await seedWithdrawal(h.db, who, { paid_at: at.q1End }),
      q2Start: await seedWithdrawal(h.db, who, { paid_at: at.q2Start }),
      q2End: await seedWithdrawal(h.db, who, { status: 'PAID_MANUAL', paid_at: at.q2End }),
      q3Start: await seedWithdrawal(h.db, who, { paid_at: at.q3Start }),
      before: await seedWithdrawal(h.db, who, { paid_at: at.before }),
    };
    const q1 = await read(h.db, { appId: who.appId, quarter: '2026-Q1' });
    expect(ids(q1.items)).toEqual(idsOf([rows.q1Start, rows.q1EarlyUtcPrevYear, rows.q1End]));
    expect(q1.next_cursor).toBeNull();
    const q2 = await read(h.db, { appId: who.appId, quarter: '2026-Q2' });
    expect(ids(q2.items)).toEqual(idsOf([rows.q2Start, rows.q2End]));
    expect(q2.next_cursor).toBeNull();
    const q3 = await read(h.db, { appId: who.appId, quarter: '2026-Q3' });
    expect(ids(q3.items)).toEqual([rows.q3Start.id]);
    expect(q3.next_cursor).toBeNull();
    const q4 = await read(h.db, { appId: who.appId, quarter: '2026-Q4' });
    expect(q4.items).toEqual([]);
    expect(q4.next_cursor).toBeNull();
  },
  TIMEOUT,
);

it(
  '[AC-B2-08d#2] Q4 跨年（规则原文例）：paid_at ∈ [2026-10-01T00:00+08:00, 2027-01-01T00:00+08:00)；按 paid_at 不按 created_at；2027-01-01 00:00 / 00:30 +08:00 归 2027-Q1',
  async () => {
    const decrypt = fakeDecrypt();
    const read = createTaxExportReader({ decrypt: decrypt.decrypt });
    const who = await member(h.db);
    const q3Last = await seedWithdrawal(h.db, who, {
      paid_at: cst('2026-09-30T23:59:59.999'),
      created_at: cst('2026-09-30T10:00:00.000'),
    });
    // Applied in Q3, paid in Q4: Q4's.
    const q4First = await seedWithdrawal(h.db, who, {
      paid_at: cst('2026-10-01T00:00:00.000'),
      created_at: cst('2026-09-30T22:00:00.000'),
    });
    const q4Mid = await seedWithdrawal(h.db, who, {
      status: 'PAID_MANUAL',
      paid_at: cst('2026-11-11T11:11:11.111'),
      created_at: cst('2026-11-10T09:00:00.000'),
    });
    // Applied in Q4, paid on the last millisecond of the year.
    const q4Last = await seedWithdrawal(h.db, who, {
      paid_at: cst('2026-12-31T23:59:59.999'),
      created_at: cst('2026-12-31T20:00:00.000'),
    });
    // Applied in Q4, paid in the next year (UTC still says 2026-12-31): 2027-Q1's.
    const nextYearStart = await seedWithdrawal(h.db, who, {
      paid_at: cst('2027-01-01T00:00:00.000'),
      created_at: cst('2026-12-31T21:00:00.000'),
    });
    const nextYearEarly = await seedWithdrawal(h.db, who, {
      status: 'PAID_MANUAL',
      paid_at: cst('2027-01-01T00:30:00.000'),
      created_at: cst('2026-12-31T22:00:00.000'),
    });
    expect(nextYearEarly.paid_at?.getUTCFullYear()).toBe(2026);
    const q4 = await read(h.db, { appId: who.appId, quarter: '2026-Q4' });
    expect(ids(q4.items)).toEqual(idsOf([q4First, q4Mid, q4Last]));
    expect(q4.next_cursor).toBeNull();
    const q3 = await read(h.db, { appId: who.appId, quarter: '2026-Q3' });
    expect(ids(q3.items)).toEqual([q3Last.id]);
    const next = await read(h.db, { appId: who.appId, quarter: '2027-Q1' });
    expect(ids(next.items)).toEqual(idsOf([nextYearStart, nextYearEarly]));
    expect(next.next_cursor).toBeNull();
  },
  TIMEOUT,
);

it(
  '[AC-B2-08d#3] 只列已到账：PAID_API / PAID_MANUAL 入列；PENDING_REVIEW / APPROVED / PAYING / REJECTED / FAILED 不入列（paid_at 有值或为 null 都不入列）',
  async () => {
    const decrypt = fakeDecrypt();
    const read = createTaxExportReader({ decrypt: decrypt.decrypt });
    const who = await member(h.db);
    const inQuarter = cst('2026-11-02T10:00:00.000');
    const paidApi = await seedWithdrawal(h.db, who, { status: 'PAID_API', paid_at: inQuarter });
    const paidManual = await seedWithdrawal(h.db, who, {
      status: 'PAID_MANUAL',
      paid_at: cst('2026-11-02T10:00:01.000'),
    });
    for (const status of ['PENDING_REVIEW', 'APPROVED', 'PAYING', 'REJECTED', 'FAILED']) {
      // A stray paid_at on an unpaid row does not make it paid.
      await seedWithdrawal(h.db, who, { status, paid_at: inQuarter });
      await seedWithdrawal(h.db, who, { status, paid_at: null });
    }
    const page = await read(h.db, { appId: who.appId, quarter: '2026-Q4' });
    expect(ids(page.items)).toEqual(idsOf([paidApi, paidManual]));
    expect(page.next_cursor).toBeNull();
    // Only the listed rows were decrypted (the unpaid snapshots stay closed).
    expect(decrypt.calls).toHaveLength(2);
  },
  TIMEOUT,
);

const FIELD_CASES = [
  { name: 'alipay 手机号', channel: 'alipay', account: ALIPAY_PHONE, masked: ALIPAY_PHONE_MASKED },
  { name: 'alipay 邮箱', channel: 'alipay', account: ALIPAY_EMAIL, masked: ALIPAY_EMAIL_MASKED },
  { name: 'bank_card', channel: 'bank_card', account: BANK_CARD, masked: BANK_CARD_MASKED },
  { name: 'wechat', channel: 'wechat', account: WECHAT_OPENID, masked: WECHAT_MASKED },
] as const;

it.each(FIELD_CASES)(
  '[AC-B2-08d#4] $name：行逐字段等于库行——amount_fen 是申请金额（不是 net）、tax_fen、paid_at、out_biz_no、payout_channel、income_type SERVICE_FEE、masked_account 经既有脱敏',
  async ({ channel, account, masked }) => {
    const decrypt = fakeDecrypt();
    const read = createTaxExportReader({ decrypt: decrypt.decrypt });
    const who = await member(h.db);
    const api = await seedWithdrawal(h.db, who, {
      status: 'PAID_API',
      payout_channel: channel,
      account,
      amount_fen: 10_000n,
      fee_fen: 300n,
      tax_fen: 700n,
      paid_at: cst('2026-12-01T08:00:00.123'),
    });
    const manual = await seedWithdrawal(h.db, who, {
      status: 'PAID_MANUAL',
      payout_channel: channel,
      account,
      amount_fen: 88_000n,
      fee_fen: 0n,
      tax_fen: 1_234n,
      paid_at: cst('2026-12-02T09:30:00.456'),
    });
    expect(api.net_fen).toBe(9_000n);
    expect(manual.net_fen).toBe(86_766n);
    const page = await read(h.db, { appId: who.appId, quarter: '2026-Q4' });
    expect(page.next_cursor).toBeNull();
    expect(page.items).toStrictEqual([expectedRow(api, account), expectedRow(manual, account)]);
    const [first, second] = page.items;
    expect(first).toMatchObject({
      withdrawal_id: api.id,
      user_id: who.userId,
      income_type: SERVICE_FEE,
      amount_fen: 10_000n,
      tax_fen: 700n,
      masked_account: masked,
      out_biz_no: api.out_biz_no,
      payout_channel: channel,
    });
    expect(second).toMatchObject({ amount_fen: 88_000n, tax_fen: 1_234n, masked_account: masked });
    expect(typeof first?.amount_fen).toBe('bigint');
    expect(typeof first?.tax_fen).toBe('bigint');
    expect(first?.paid_at).toBeInstanceOf(Date);
    expect(first?.paid_at.toISOString()).toBe('2026-12-01T00:00:00.123Z');
    expect(second?.paid_at.toISOString()).toBe('2026-12-02T01:30:00.456Z');
    // The row's own snapshot was decrypted with its payout method, once per row.
    expect(decrypt.calls).toEqual([
      { cipher: `cipher:${account}`, method: channel },
      { cipher: `cipher:${account}`, method: channel },
    ]);
  },
  TIMEOUT,
);

it.each(FIELD_CASES)(
  '[AC-B2-08d#5] $name：行的键精确为 9 个；行 JSON 文本里没有姓名、明文账户、密文、HMAC、银行名',
  async ({ channel, account }) => {
    const decrypt = fakeDecrypt();
    const read = createTaxExportReader({ decrypt: decrypt.decrypt });
    const who = await member(h.db);
    const row = await seedWithdrawal(h.db, who, {
      status: 'PAID_MANUAL',
      payout_channel: channel,
      account,
      paid_at: cst('2026-10-20T12:00:00.000'),
    });
    const page = await read(h.db, { appId: who.appId, quarter: '2026-Q4' });
    expect(page.items).toHaveLength(1);
    const [item] = page.items;
    expect(Object.keys(item ?? {}).sort()).toEqual([...ROW_KEYS]);
    const text = serialise(page);
    for (const secret of [PAYEE_NAME, account, row.payee_hmac, 'cipher:', BANK_NAME]) {
      expect(text).not.toContain(secret);
    }
    for (const key of [
      'payee_name',
      'payee_account_cipher',
      'payee_hmac',
      'bank_name',
      'net_fen',
      'fee_fen',
      'status',
      'name',
      'id_no',
    ]) {
      expect(item).not.toHaveProperty(key);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-08d#6] 多 app 隔离：别的 app 同季度、同到账时间的已到账单不入列；没有单的 app 得空页',
  async () => {
    const decrypt = fakeDecrypt();
    const read = createTaxExportReader({ decrypt: decrypt.decrypt });
    const mine = await member(h.db);
    const theirs = await member(h.db);
    const sameAt = cst('2026-10-08T08:08:08.008');
    const own = [
      await seedWithdrawal(h.db, mine, { paid_at: sameAt }),
      await seedWithdrawal(h.db, mine, { status: 'PAID_MANUAL', paid_at: sameAt }),
    ];
    // A second member of my app is listed too (the export is per app, not per member).
    const neighbour = { appId: mine.appId, userId: await seedUser(h.db, mine.appId) };
    own.push(await seedWithdrawal(h.db, neighbour, { paid_at: cst('2026-10-09T00:00:00.000') }));
    const foreign = [
      await seedWithdrawal(h.db, theirs, { paid_at: sameAt }),
      await seedWithdrawal(h.db, theirs, { status: 'PAID_MANUAL', paid_at: sameAt }),
    ];
    const minePage = await read(h.db, { appId: mine.appId, quarter: '2026-Q4' });
    expect(ids(minePage.items)).toEqual(idsOf(own));
    expect(minePage.items.map((item) => item.user_id).sort()).toEqual(
      [mine.userId, mine.userId, neighbour.userId].sort(),
    );
    const theirsPage = await read(h.db, { appId: theirs.appId, quarter: '2026-Q4' });
    expect(ids(theirsPage.items)).toEqual(idsOf(foreign));
    const empty = await read(h.db, { appId: `tx_absent_${mine.appId}`, quarter: '2026-Q4' });
    expect(empty).toStrictEqual({ items: [], next_cursor: null });
  },
  TIMEOUT,
);

it(
  '[AC-B2-08d#7] 在调用方句柄上只读：READ ONLY 事务里可读；调用前后提现行（含 row_version、updated_at）、分录、事件、tax_ytd 不变；事务内看得到未提交的单，别的连接看不到',
  async () => {
    const decrypt = fakeDecrypt();
    const read = createTaxExportReader({ decrypt: decrypt.decrypt });
    const who = await member(h.db);
    const rows = [
      await seedWithdrawal(h.db, who, { paid_at: cst('2026-10-03T00:00:00.000'), row_version: 4 }),
      await seedWithdrawal(h.db, who, {
        status: 'PAID_MANUAL',
        payout_channel: 'bank_card',
        paid_at: cst('2026-10-04T00:00:00.000'),
        row_version: 6,
      }),
      await seedWithdrawal(h.db, who, { status: 'PAYING', paid_at: null, row_version: 2 }),
    ];
    const before = await footprint(h.db, who.appId);
    expect(before.withdrawals).toHaveLength(3);
    // Any INSERT / UPDATE / DELETE (or nextval) inside a READ ONLY transaction raises 25006.
    const page = await h.db.transaction().execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      return read(trx, { appId: who.appId, quarter: '2026-Q4', limit: 1 });
    });
    expect(ids(page.items)).toEqual([rows[0]?.id]);
    expect(page.next_cursor).not.toBeNull();
    await read(h.db, { appId: who.appId, quarter: '2026-Q4' });
    await read(h.db, { appId: who.appId, quarter: '2026-Q4' });
    const after = await footprint(h.db, who.appId);
    expect(after).toStrictEqual(before);
    // The caller's handle: its own uncommitted row is seen, another connection does not see it.
    await h.db.transaction().execute(async (trx) => {
      const fresh = await seedWithdrawal(trx, who, { paid_at: cst('2026-10-05T00:00:00.000') });
      const inside = await read(trx, { appId: who.appId, quarter: '2026-Q4' });
      expect(ids(inside.items)).toEqual([rows[0]?.id, rows[1]?.id, fresh.id]);
      const outside = await read(h.observer, { appId: who.appId, quarter: '2026-Q4' });
      expect(ids(outside.items)).toEqual([rows[0]?.id, rows[1]?.id]);
    });
  },
  TIMEOUT,
);
