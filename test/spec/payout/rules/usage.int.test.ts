// Only the container/CI integration project executes this file. Its globalSetup reads
// TEST_PG_ADMIN_URL and creates the migrated disposable template; never a production DB.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWithdrawUsageReader } from '../../../../apps/api/src/modules/payout/infra/withdraw-usage.ts';
import { createWithdrawHoldsReader } from '../../../../apps/api/src/modules/payout/infra/withdraw-holds.ts';
import type { WithdrawHold } from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';
import { createWithdrawSubjectReader } from '../../../../apps/api/src/modules/identity/ports/withdraw-subject.ts';
import { createAppealPrevStateReader } from '../../../../apps/api/src/modules/risk/ports/appeal-prev-state.ts';
import { createBlocklistMatchReader } from '../../../../apps/api/src/modules/risk/ports/blocklist-match.ts';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 120000);
afterAll(async () => {
  if (db) await destroyDb(db);
  if (database) await database.drop();
}, 30000);

async function user(handle: Kysely<DB>, app: string) {
  const id = randomUUID();
  await sql`INSERT INTO app.users (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, status)
    VALUES (${id}, ${app}, 'synthetic', 'synthetic', ${id.slice(0, 8)}, ${id.slice(9, 18)}, 'L1', 'sms', 'normal')`.execute(
    handle,
  );
  return id;
}

async function withdrawal(
  handle: Kysely<DB>,
  app: string,
  uid: string,
  options: {
    at: string;
    status?: string;
    amount?: bigint;
    hmac?: string;
    method?: 'alipay' | 'bank_card';
  },
) {
  const status = options.status ?? 'PENDING_REVIEW';
  const id = randomUUID();
  const amount = options.amount ?? 100n;
  const paid = status === 'PAID_API' || status === 'PAID_MANUAL';
  await sql`INSERT INTO app.withdrawals
    (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
     payee_name, payee_account_cipher, payee_hmac, bank_name, status, out_biz_no, payout_channel,
     paid_at, manual_entry_by, manual_confirm_by, reject_reason_code, created_at, updated_at)
    VALUES (${id}, ${app}, ${uid}, ${amount}, 0, 0, ${amount}, 'SERVICE_FEE', ${options.method ?? 'alipay'},
      'synthetic', ${Buffer.from('synthetic-cipher')}, ${options.hmac ?? 'a'.repeat(64)}, ${options.method === 'bank_card' ? 'synthetic bank' : null},
      ${status}, ${id.replaceAll('-', '')}, ${options.method ?? 'alipay'},
      ${paid ? options.at : null}::timestamptz, ${status === 'PAID_MANUAL' ? randomUUID() : null}::uuid,
      ${status === 'PAID_MANUAL' ? randomUUID() : null}::uuid, ${status === 'REJECTED' ? 'USER_REQUEST' : null},
      ${options.at}::timestamptz, ${options.at}::timestamptz)`.execute(handle);
}

async function fixture() {
  const app = `withdraw_${randomUUID()}`;
  const uid = await user(db, app);
  return {
    app,
    uid,
    query: {
      appId: app,
      userId: uid,
      deviceId: randomUUID(),
      payeeHmac: 'a'.repeat(64),
      now: new Date('2026-10-01T04:00:00Z'),
    },
  };
}

it.each(['PENDING_REVIEW', 'APPROVED', 'PAYING', 'PAID_API', 'PAID_MANUAL', 'REJECTED', 'FAILED'])(
  '[AC-B2-05c#60] status=%s 的日月次数与未成年月申请额只排除驳回/失败',
  async (status) => {
    const reader = createWithdrawUsageReader();
    const f = await fixture();
    await withdrawal(db, f.app, f.uid, { at: '2026-10-01T00:00:00Z', status, amount: 12300n });
    const counted = status !== 'REJECTED' && status !== 'FAILED';
    expect(await reader.read(db, f.query)).toEqual({
      daily_count: counted ? 1 : 0,
      monthly_count: counted ? 1 : 0,
      payee_daily_count: counted ? 1 : 0,
      payee_daily_other_users: 0,
      monthly_amount_fen: counted ? 12300n : 0n,
    });
  },
);

it.each([
  ['2026-09-30T15:59:59.999Z', 0, 0],
  ['2026-09-30T16:00:00.000Z', 1, 1],
  ['2026-10-01T15:59:59.999Z', 1, 1],
  ['2026-10-01T16:00:00.000Z', 0, 1],
  ['2026-10-31T15:59:59.999Z', 0, 1],
  ['2026-10-31T16:00:00.000Z', 0, 0],
] as const)('[AC-B2-05c#61] +08:00 日月半开区间 created_at=%s', async (at, daily, monthly) => {
  const reader = createWithdrawUsageReader();
  const f = await fixture();
  await withdrawal(db, f.app, f.uid, { at, amount: 321n });
  expect(await reader.read(db, f.query)).toEqual({
    daily_count: daily,
    monthly_count: monthly,
    payee_daily_count: daily,
    payee_daily_other_users: 0,
    monthly_amount_fen: monthly === 1 ? 321n : 0n,
  });
});

it.each(['alipay', 'bank_card'] as const)(
  '[AC-B2-05c#62] %s 按历史快照 HMAC 跨会员计次数，人数去重且排除自己',
  async (method) => {
    const reader = createWithdrawUsageReader();
    const f = await fixture();
    const other = await user(db, f.app);
    const ignored = await user(db, f.app);
    const at = '2026-10-01T00:00:00Z';
    await withdrawal(db, f.app, f.uid, { at, method });
    await withdrawal(db, f.app, f.uid, { at, method });
    await withdrawal(db, f.app, other, { at, method });
    await withdrawal(db, f.app, other, { at, method });
    await withdrawal(db, f.app, ignored, { at, method, status: 'REJECTED' });
    await withdrawal(db, f.app, ignored, { at, method, status: 'FAILED' });
    await withdrawal(db, f.app, ignored, { at, method, hmac: 'b'.repeat(64) });
    await withdrawal(db, f.app, ignored, { at: '2026-09-30T15:59:59.999Z', method });
    expect(await reader.read(db, f.query)).toEqual({
      daily_count: 2,
      monthly_count: 2,
      payee_daily_count: 4,
      payee_daily_other_users: 1,
      monthly_amount_fen: 200n,
    });
  },
);

it('[AC-B2-05c#63] 相同 HMAC 跨 app 不串次数/人数；会员计数不被换绑重置', async () => {
  const reader = createWithdrawUsageReader();
  const f = await fixture();
  const foreign = `other_${randomUUID()}`;
  const foreignUid = await user(db, foreign);
  await withdrawal(db, foreign, foreignUid, { at: '2026-10-01T00:00:00Z' });
  await withdrawal(db, f.app, f.uid, {
    at: '2026-10-01T00:00:00Z',
    hmac: 'b'.repeat(64),
    amount: 567n,
  });
  expect(await reader.read(db, f.query)).toEqual({
    daily_count: 1,
    monthly_count: 1,
    payee_daily_count: 0,
    payee_daily_other_users: 0,
    monthly_amount_fen: 567n,
  });
});

it('[AC-B2-05c#64] 使用调用方事务，看到未提交申请；读统计不改任何状态', async () => {
  const reader = createWithdrawUsageReader();
  const f = await fixture();
  await db.transaction().execute(async (trx) => {
    await withdrawal(trx, f.app, f.uid, { at: '2026-10-01T00:00:00Z', amount: 789n });
    expect(await reader.read(trx, f.query)).toMatchObject({
      daily_count: 1,
      monthly_count: 1,
      monthly_amount_fen: 789n,
    });
    const { rows } = await sql<{
      status: string;
    }>`SELECT status FROM app.withdrawals WHERE app_id = ${f.app}`.execute(trx);
    expect(rows).toEqual([{ status: 'PENDING_REVIEW' }]);
  });
});

it.each(['alipay', 'bank_card'] as const)(
  '[AC-B2-05c#65] identity 端口只读当前 %s 绑定，历史记录不覆盖快照',
  async (method) => {
    const reader = createWithdrawSubjectReader();
    const f = await fixture();
    const subject = { appId: f.app, userId: f.uid };
    expect(await reader.read(db, subject)).toBeNull();
    for (const current of [true, false]) {
      const hash = (current ? 'a' : 'b').repeat(64);
      await sql`INSERT INTO app.payout_accounts (id, app_id, user_id, payout_method,
      alipay_logon_id_cipher, alipay_hmac, bank_card_no_cipher, bank_card_hmac, bank_name, card_bin, payee_name, is_current)
      VALUES (${randomUUID()}, ${f.app}, ${f.uid}, ${method},
        ${method === 'alipay' ? Buffer.from('synthetic') : null}, ${method === 'alipay' ? hash : null},
        ${method === 'bank_card' ? Buffer.from('synthetic') : null}, ${method === 'bank_card' ? hash : null},
        ${method === 'bank_card' ? 'synthetic bank' : null}, ${method === 'bank_card' ? '622202' : null},
        ${current ? '阿·甲' : '旧绑定'}, ${current})`.execute(db);
    }
    await db.transaction().execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      expect(await reader.read(trx, subject)).toEqual({
        payout_method: method,
        payee_name: '阿·甲',
        payee_hmac: 'a'.repeat(64),
      });
      expect(await reader.read(trx, { ...subject, appId: `other_${f.app}` })).toBeNull();
    });
  },
);

it.each(['banned', 'frozen'] as const)(
  '[AC-B2-05c#66] appealing 的 prev 只读本用户当前账号申诉：%s',
  async (prev) => {
    const reader = createAppealPrevStateReader();
    const f = await fixture();
    const subject = { appId: f.app, userId: f.uid };
    await sql`INSERT INTO app.appeals
    (id, app_id, user_id, target_type, target_id, prev_risk_state, status, content, deadline_at, closed_at, handler_id)
    VALUES (${randomUUID()}, ${f.app}, ${f.uid}, 'account', ${f.uid}, ${prev === 'banned' ? 'frozen' : 'banned'},
      'revoked', 'synthetic old appeal', '2026-11-01T00:00:00Z', '2026-09-01T00:00:00Z', 'synthetic handler')`.execute(
      db,
    );
    await sql`INSERT INTO app.appeals (id, app_id, user_id, target_type, target_id, status, content, deadline_at)
    VALUES (${randomUUID()}, ${f.app}, ${f.uid}, 'order', ${randomUUID()}, 'processing', 'synthetic order appeal', '2026-11-01T00:00:00Z')`.execute(
      db,
    );
    expect(await reader.read(db, subject)).toBeNull();
    await db.transaction().execute(async (trx) => {
      await sql`INSERT INTO app.appeals (id, app_id, user_id, target_type, target_id, prev_risk_state, status, content, deadline_at)
      VALUES (${randomUUID()}, ${f.app}, ${f.uid}, 'account', ${f.uid}, ${prev}, 'processing', 'synthetic account appeal', '2026-11-01T00:00:00Z')`.execute(
        trx,
      );
      expect(await reader.read(trx, subject)).toBe(prev);
      expect(await reader.read(trx, { ...subject, appId: `other_${f.app}` })).toBeNull();
    });
  },
);

it.each(['phone', 'id_no', 'device', 'alipay', 'bank_card', 'wechat_openid'] as const)(
  '[AC-B2-05c#67] BR-WDR-03 ③a 任一黑名单维度 %s 命中；只读调用不记录写入',
  async (dimension) => {
    const reader = createBlocklistMatchReader();
    const f = await fixture();
    const hash = 'c'.repeat(64);
    const deviceId = randomUUID();
    const now = f.query.now;
    await sql`UPDATE app.users SET phone_hmac = ${hash} WHERE app_id = ${f.app} AND id = ${f.uid}`.execute(
      db,
    );
    await sql`INSERT INTO app.realname (id, app_id, user_id, name_cipher, id_no_cipher, id_no_hmac, birth_date_cipher, status, provider, verified_at)
      VALUES (${randomUUID()}, ${f.app}, ${f.uid}, ${Buffer.from('synthetic')}, ${Buffer.from('synthetic')}, ${hash}, ${Buffer.from('synthetic')}, 'verified', 'synthetic', ${now})`.execute(
      db,
    );
    await sql`INSERT INTO app.devices (id, app_id, user_id, device_hash, id_source, platform, app_version, last_seen_at, install_secret_cipher)
      VALUES (${deviceId}, ${f.app}, ${f.uid}, ${hash}, 'idfv', 'ios', '1.0.0', ${now}, ${Buffer.from('synthetic')})`.execute(
      db,
    );
    const payoutMethod =
      dimension === 'bank_card' ? 'bank_card' : dimension === 'wechat_openid' ? 'wechat' : 'alipay';
    const subject = {
      appId: f.app,
      userId: f.uid,
      deviceId,
      payeeHmac: hash,
      payoutMethod,
      now,
    } as const;
    expect(await reader.read(db, subject)).toBeNull();
    await sql`INSERT INTO app.blocklist (id, app_id, dimension, value_hmac, violation_type, expire_at, status, created_by)
      VALUES (${randomUUID()}, ${f.app}, ${dimension}, ${hash}, 'other', '2026-11-01T00:00:00Z', 'active', 'synthetic')`.execute(
      db,
    );
    await db.transaction().execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      expect(await reader.read(trx, subject)).toEqual({ risk_msg_code: expect.any(String) });
      expect(await reader.read(trx, { ...subject, appId: `other_${f.app}` })).toBeNull();
    });
  },
);

it('[AC-B2-05c#68] holds 原样读取本 app 本用户全部记录，并看到调用方事务未提交行', async () => {
  const reader = createWithdrawHoldsReader();
  const f = await fixture();
  const foreignApp = `other_${randomUUID()}`;
  const foreignUid = await user(db, foreignApp);
  const expected: WithdrawHold[] = [
    { reason: 'ledger_mismatch', released_at: null, hold_until: null },
    { reason: 'manual', released_at: new Date('2026-09-30T00:00:00Z'), hold_until: null },
    { reason: 'recon_diff', released_at: null, hold_until: new Date('2026-09-30T00:00:00Z') },
  ];
  await sql`INSERT INTO app.withdraw_holds (id, app_id, user_id, reason, created_by)
    VALUES (${randomUUID()}, ${foreignApp}, ${foreignUid}, 'manual_failed_watch', 'synthetic')`.execute(
    db,
  );
  await db.transaction().execute(async (trx) => {
    for (const row of expected) {
      await sql`INSERT INTO app.withdraw_holds
        (id, app_id, user_id, reason, created_by, hold_until, released_at, released_by)
        VALUES (${randomUUID()}, ${f.app}, ${f.uid}, ${row.reason}, 'synthetic',
          ${row.hold_until}, ${row.released_at}, ${row.released_at === null ? null : 'synthetic'})`.execute(
        trx,
      );
    }
    const rows = await reader.read(trx, f.query);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(expect.arrayContaining(expected));
    expect(await reader.read(trx, { ...f.query, appId: foreignApp })).toEqual([]);
    expect(await reader.read(trx, { ...f.query, userId: foreignUid })).toEqual([]);
  });
});
