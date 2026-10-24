// B1-27f (08 BR-ID-40 细则「导出范围（默认）」; BR-ID-30 ①; BR-ID-33 脱敏格式; brief §9): the content of a
// personal information copy as app.module assembles its sources — identity's own sections and the
// owners' read-only files through their index.ts — read for one member on a READ ONLY transaction
// of a cloned test database (couli_app). Every section holds only the member's own data: nothing of
// the inviter, the invitees, another member, a guest of the same device or the console staff.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  ALIPAY,
  BIRTH_DATE,
  CARD_NO,
  CREDIT_FEN,
  ID_NO,
  MASKED_ID_NO,
  MASKED_NAME,
  NICKNAME,
  PHONE,
  REAL_NAME,
  REGISTERED_AT_MS,
  SECTIONS,
  VERIFIED_AT_MS,
  at,
  binds,
  byKey,
  close,
  collect,
  isPlainRead,
  observe,
  open,
  owners,
  readOnly,
  text,
  withdrawalDecrypt,
  world,
  type Kit,
  type Section,
} from './kit.ts';

const TIMEOUT = 120_000;
let database: TestDatabase | undefined;
let kit: Kit | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  kit = await open(database);
}, TIMEOUT);

afterAll(async () => {
  try {
    await close(kit);
  } finally {
    await database?.drop();
  }
});

function harness(): Kit {
  if (kit === undefined) throw new Error('the test database is not open');
  return kit;
}

/** The values to look for, nulls left out; none may be "" (every text contains ""). */
function present(values: readonly (string | null)[]): string[] {
  const kept = values.filter((value): value is string => value !== null);
  expect(kept).not.toContain('');
  return kept;
}

it(
  '[AC-B1-27f#1] 账号资料：昵称、完整绑定手机号、第三方登录方式、注册时间；未绑手机号为 null，用户不存在为 null',
  async () => {
    const k = harness();
    const w = await world(k.db, k.crypto);
    const sources = await k.sources();
    const own = await readOnly(k.db, (trx) => sources.account(trx, w.a.subject));
    expect(own).not.toBeNull();
    const sorted =
      own === null ? null : { ...own, login_providers: [...own.login_providers].sort() };
    expect(sorted).toEqual({
      nickname: NICKNAME,
      phone: PHONE,
      login_providers: ['apple', 'wechat'],
      registered_at: at(REGISTERED_AT_MS),
    });
    expect(await readOnly(k.db, (trx) => sources.account(trx, w.bare.subject))).toEqual({
      nickname: w.bare.nickname,
      phone: null,
      login_providers: [],
      registered_at: at(-5 * 86_400_000),
    });
    const unknown = { appId: w.appId, userId: '00000000-0000-4000-8000-000000000000' };
    expect(await readOnly(k.db, (trx) => sources.account(trx, unknown))).toBeNull();
    // The same member id in another app is not this member.
    const elsewhere = { appId: `${w.appId}_x`, userId: w.a.uid };
    expect(await readOnly(k.db, (trx) => sources.account(trx, elsewhere))).toBeNull();
  },
  TIMEOUT,
);

it(
  '[AC-B1-27f#2] 实名信息只给脱敏值（**三、1****************X）与核验时间，不带姓名、身份证号、出生日期明文；无实名记录为 none',
  async () => {
    const k = harness();
    const w = await world(k.db, k.crypto);
    const sources = await k.sources();
    const own = await readOnly(k.db, (trx) => sources.realname(trx, w.a.subject));
    expect(own).toEqual({
      status: 'verified',
      masked_name: MASKED_NAME,
      masked_id_no: MASKED_ID_NO,
      verified_at: at(VERIFIED_AT_MS),
    });
    for (const secret of [REAL_NAME, ID_NO, BIRTH_DATE, ID_NO.slice(0, 17)]) {
      expect(text(own)).not.toContain(secret);
    }
    expect(await readOnly(k.db, (trx) => sources.realname(trx, w.bare.subject))).toEqual({
      status: 'none',
      masked_name: null,
      masked_id_no: null,
      verified_at: null,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-27f#3] 同意记录：本人（subject_type user）的每一条；设备维度的同意与他人的同意不进副本',
  async () => {
    const k = harness();
    const w = await world(k.db, k.crypto);
    const sources = await k.sources();
    const consents = await readOnly(k.db, (trx) => sources.consents(trx, w.a.subject));
    expect(byKey(consents, (row) => row.type)).toEqual(byKey(w.consents, (row) => row.type));
    expect(await readOnly(k.db, (trx) => sources.consents(trx, w.bare.subject))).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-27f#4] 订单：本人在本 app 的全部订单（含一年多以前的），不含他人订单',
  async () => {
    const k = harness();
    const w = await world(k.db, k.crypto);
    const sources = await k.sources();
    const orders = await readOnly(k.db, (trx) => sources.orders(trx, w.a.subject));
    expect(byKey(orders, (row) => row.order_id)).toEqual(byKey(w.orders, (row) => row.order_id));
    expect(text(orders)).not.toContain(w.otherOrder.order_id);
    expect(await readOnly(k.db, (trx) => sources.orders(trx, w.bare.subject))).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-27f#5] 余额流水：只有本人余额账户的分录，不含同一凭证上平台科目的对方分录，也不含他人分录',
  async () => {
    const k = harness();
    const w = await world(k.db, k.crypto);
    const sources = await k.sources();
    const entries = await readOnly(k.db, (trx) => sources.ledger(trx, w.a.subject));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      ledger_type: 'REBATE_CREDIT',
      sub_type: null,
      sub_account: 'available',
      amount_fen: CREDIT_FEN,
      booked_at: at(0),
    });
    expect(entries.map((row) => row.amount_fen)).not.toContain(-CREDIT_FEN);
    expect(entries.map((row) => row.amount_fen)).not.toContain(5678n);
    expect(await readOnly(k.db, (trx) => sources.ledger(trx, w.bare.subject))).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-27f#6] 提现记录：本人的每一笔，收款账号脱敏（zh***@example.com、尾号 0123），不带账号与收款人姓名明文、处理它的后台人员，不含他人提现',
  async () => {
    const k = harness();
    const w = await world(k.db, k.crypto);
    const sources = await k.sources();
    const withdrawals = await readOnly(k.db, (trx) => sources.withdrawals(trx, w.a.subject));
    expect(byKey(withdrawals, (row) => row.withdrawal_id)).toEqual(
      byKey(w.withdrawals, (row) => row.withdrawal_id),
    );
    const written = text(withdrawals);
    for (const secret of [ALIPAY, CARD_NO, REAL_NAME, w.adminId, w.otherWithdrawal.withdrawal_id]) {
      expect(written).not.toContain(secret);
    }
    expect(await readOnly(k.db, (trx) => sources.withdrawals(trx, w.bare.subject))).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-27f#7] Agent 对话：本人未过留存期（BR-ID-30 ① 190 天）的会话连同消息（按时间先后），已闲置结束的也在；超过留存期的、同设备访客会话、他人会话与后台的举报处理不进副本',
  async () => {
    const k = harness();
    const w = await world(k.db, k.crypto);
    const sources = await k.sources();
    const conversations = await readOnly(k.db, (trx) => sources.agent(trx, w.a.subject));
    expect(conversations).toEqual([w.liveConversation]);
    const written = text(conversations);
    for (const absent of present([
      w.oldConversation.session_id,
      w.guestConversation.session_id,
      w.otherConversation.session_id,
      ...w.oldConversation.messages.map((message) => message.text),
      ...w.guestConversation.messages.map((message) => message.text),
      ...w.otherConversation.messages.map((message) => message.text),
      w.reportNote,
      w.adminId,
    ])) {
      expect(written).not.toContain(absent);
    }
    expect(await readOnly(k.db, (trx) => sources.agent(trx, w.bare.subject))).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-27f#8] 邀请关系只写是否已绑定邀请人：有上级为 true、没有为 false，用户不存在为 false',
  async () => {
    const k = harness();
    const w = await world(k.db, k.crypto);
    const sources = await k.sources();
    const read = (subject: { appId: string; userId: string }) =>
      readOnly(k.db, (trx) => sources.invite(trx, subject));
    expect(await read(w.a.subject)).toEqual({ has_inviter: true });
    expect(await read(w.invitee.subject)).toEqual({ has_inviter: true });
    expect(await read(w.inviter.subject)).toEqual({ has_inviter: false });
    expect(await read(w.bare.subject)).toEqual({ has_inviter: false });
    expect(await read({ appId: w.appId, userId: '00000000-0000-4000-8000-000000000000' })).toEqual({
      has_inviter: false,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-27f#9] 整份副本不含他人信息：邀请人、下级、同 app 其他用户、同设备访客与后台人员的标识、昵称、手机号、邀请码、订单、提现与对话都不出现',
  async () => {
    const k = harness();
    const w = await world(k.db, k.crypto);
    const sources = await k.sources();
    const copy = await readOnly(k.db, (trx) => collect(sources, trx, w.a.subject));
    const written = text(copy);
    expect(written).toContain(PHONE);
    for (const someone of [w.inviter, w.invitee, w.other, w.bare]) {
      for (const value of present([
        someone.uid,
        someone.nickname,
        someone.inviteCode,
        someone.phone,
      ])) {
        expect(written).not.toContain(value);
      }
    }
    for (const absent of present([
      w.otherOrder.order_id,
      w.otherOrder.title,
      w.otherWithdrawal.withdrawal_id,
      w.otherConversation.session_id,
      w.guestConversation.session_id,
      ...w.guestConversation.messages.map((message) => message.text),
      ...w.otherConversation.messages.map((message) => message.text),
      w.adminId,
      w.reportNote,
      '李四五',
      '110101198805051234',
      'lisi@example.com',
    ])) {
      expect(written).not.toContain(absent);
    }
    // The member's own secrets appear only masked (the phone is the one full value).
    for (const secret of [REAL_NAME, ID_NO, BIRTH_DATE, ALIPAY, CARD_NO]) {
      expect(written).not.toContain(secret);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-27f#10] 只读：整份副本在调用方给的 READ ONLY 事务上取完，每段都只发不加锁的 SELECT，并按 app_id 与本人取数',
  async () => {
    const k = harness();
    const w = await world(k.db, k.crypto);
    const sources = await k.sources();
    await readOnly(k.db, async (trx) => {
      for (const section of SECTIONS) {
        const { handle, statements } = observe(trx);
        await sources[section](handle, w.a.subject);
        expect(statements.length, `${section} issued no statement`).toBeGreaterThan(0);
        for (const statement of statements) {
          expect(isPlainRead(statement), `${section}: ${statement.sql}`).toBe(true);
          expect(binds(statement, w.appId), `${section} not scoped by app_id`).toBe(true);
        }
        expect(
          statements.some((statement) => binds(statement, w.a.uid)),
          `${section} never names the member`,
        ).toBe(true);
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-27f#11] 装配：app.module 给的五段与 orders / ledger / payout / agent / growth 各自 index.ts 导出的只读函数结果一致',
  async () => {
    const k = harness();
    const w = await world(k.db, k.crypto);
    const sources = await k.sources();
    const o = await owners();
    const withdrawals = o.payout.createPersonalDataCopyWithdrawalsReader({
      decrypt: withdrawalDecrypt(k.crypto),
    });
    const agent = o.agent.createPersonalDataCopyAgentReader({ clock: k.clock });
    const reads: Record<Exclude<Section, 'account' | 'realname' | 'consents'>, () => unknown> = {
      orders: () => readOnly(k.db, (trx) => o.orders.readPersonalDataCopyOrders(trx, w.a.subject)),
      ledger: () =>
        readOnly(k.db, (trx) => o.ledger.readPersonalDataCopyLedgerEntries(trx, w.a.subject)),
      withdrawals: () => readOnly(k.db, (trx) => withdrawals(trx, w.a.subject)),
      agent: () => readOnly(k.db, (trx) => agent(trx, w.a.subject)),
      invite: () => readOnly(k.db, (trx) => o.growth.readPersonalDataCopyInvite(trx, w.a.subject)),
    };
    for (const [section, read] of Object.entries(reads) as [keyof typeof reads, () => unknown][]) {
      const assembled = await readOnly<unknown>(k.db, (trx) => sources[section](trx, w.a.subject));
      expect(assembled, section).toEqual(await read());
    }
  },
  TIMEOUT,
);
