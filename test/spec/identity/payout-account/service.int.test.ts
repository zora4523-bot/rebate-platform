import { readFileSync } from 'node:fs';
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
  MASKED_NAME,
  NAME,
  NOW,
  ROOT,
  account,
  block,
  change,
  close,
  config,
  fixture,
  open,
  privateDataAbsent,
  save,
  service,
  state,
  type Kit,
} from './kit.ts';

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

interface Vector {
  input: string;
  note: string;
  expected?: string;
  error?: { code: number; reason?: string };
}
const vectors = (file: string) =>
  (JSON.parse(readFileSync(new URL(`specs/${file}`, ROOT), 'utf8')) as { cases: Vector[] }).cases;

it.each([
  ...vectors('payout-logon-normalize.vectors.json'),
  ...vectors('phone-normalize.vectors.json'),
])('[AC-B1-13e#1] 登录号向量 $note 经真实服务规范化后加密与 HMAC，失败不写行', async (vector) => {
  const f = await fixture(kit);
  const result = await save(kit, f, { alipayLogonId: vector.input });
  const rows = await state(kit, f);
  if (vector.expected !== undefined) {
    expect(result.code).toBe(0);
    expect(rows.accounts).toHaveLength(1);
    const stored = rows.accounts[0]!;
    const cipher = stored.alipay_logon_id_cipher!.toString('utf8');
    expect(cipher).toMatch(/^v1\.[1-9][0-9]*\./);
    expect(kit.crypto.decrypt(cipher, ALIPAY_CONTEXT)).toBe(vector.expected);
    expect(stored).toMatchObject({
      app_id: f.appId,
      user_id: f.uid,
      is_current: true,
      payee_name: NAME,
      alipay_hmac: kit.crypto.blindIndex(vector.expected, ALIPAY_CONTEXT),
      bank_card_no_cipher: null,
      bank_card_hmac: null,
      bank_name: null,
      card_bin: null,
    });
    expect(rows.changes).toEqual([]);
    privateDataAbsent(kit, [result], [NAME, vector.expected, cipher, stored.alipay_hmac!]);
  } else {
    expect(result).toEqual({
      code: 20001,
      data: {
        fields: ['alipay_logon_id'],
        ...(vector.error?.reason ? { reason: vector.error.reason } : {}),
      },
    });
    expect(rows).toEqual({ accounts: [], changes: [] });
  }
});

it('[AC-B1-13e#2] 首绑返回脱敏账号，不计次；存储时刻取注入 Clock', async () => {
  const f = await fixture(kit);
  expect(await save(kit, f)).toEqual({
    code: 0,
    data: {
      payout_method: 'alipay',
      masked_account: 'zh***@example.com',
      masked_payee_name: MASKED_NAME,
      change_remaining_this_month: 2,
    },
  });
  const rows = await state(kit, f);
  expect(rows.changes).toEqual([]);
  expect(rows.accounts).toHaveLength(1);
  expect(rows.accounts[0]).toMatchObject({
    created_at: kit.clock.now(),
    updated_at: kit.clock.now(),
  });
  const warnings = kit.lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['level'] === 40);
  expect(warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ config_key: 'withdraw.payout_methods' }),
      expect.objectContaining({ config_key: 'withdraw.payout_account_change_per_month' }),
    ]),
  );
});

it.each(['•', '.', '．', '・', '·'])(
  '[AC-B1-13e#3] 实名与收款姓名都规范化：分隔符 %s、NFKC 与首尾空白',
  async (separator) => {
    const f = await fixture(kit, { name: `\u3000Ａ依古丽${separator}买买提\u00a0` });
    const result = await save(kit, f, { payeeName: '\u00a0A依古丽・买买提\u3000' });
    expect(result.code).toBe(0);
    expect((await state(kit, f)).accounts[0]?.payee_name).toBe('A依古丽·买买提');
  },
);

it('[AC-B1-13e#4] 姓名不等返回 30307；无 verified 记录返回 30304，均不写账号或变更', async () => {
  const f = await fixture(kit);
  const absent = await fixture(kit, { verified: false });
  expect(await save(kit, f, { payeeName: '另一位收款人' })).toEqual({ code: 30307 });
  expect(await save(kit, absent)).toEqual({ code: 30304 });
  expect(await state(kit, f)).toEqual({ accounts: [], changes: [] });
  expect(await state(kit, absent)).toEqual({ accounts: [], changes: [] });
});

it('[AC-B1-13e#5] 黑名单 44001 优先于姓名、占用和月上限；收款记录不变', async () => {
  const f = await fixture(kit);
  const owner = await fixture(kit, { appId: f.appId });
  await account(kit, f, 'old@example.com');
  await account(kit, owner, '13800138000');
  await change(kit, f);
  await change(kit, f);
  await block(kit, f, '13800138000');
  const before = await state(kit, f);
  const result = await save(kit, f, { alipayLogonId: '+86 138-0013-8000', payeeName: '错误姓名' });
  expect(result).toMatchObject({ code: 44001, data: { risk_msg_code: 'blocklist.other' } });
  expect(await state(kit, f)).toEqual(before);
  privateDataAbsent(kit, [result], ['错误姓名', '13800138000', owner.uid]);
});

it.each(['inactive', 'expired', 'other-app'] as const)(
  '[AC-B1-13e#6] 非生效黑名单 %s 不阻止绑定',
  async (kind) => {
    const f = await fixture(kit);
    const subject = kind === 'other-app' ? await fixture(kit) : f;
    await block(kit, subject, LOGIN, {
      ...(kind === 'inactive' ? { status: 'inactive' as const } : {}),
      ...(kind === 'expired' ? { expireAt: kit.clock.now() } : {}),
    });
    expect((await save(kit, f)).code).toBe(0);
    expect((await state(kit, f)).accounts).toHaveLength(1);
  },
);

it('[AC-B1-13e#7] 姓名 30307 先于其他用户占用 30308，后者先于次数 30303；失败保持原行', async () => {
  const f = await fixture(kit);
  const other = await fixture(kit, { appId: f.appId });
  await account(kit, f, 'old@example.com');
  await account(kit, other);
  await change(kit, f);
  await change(kit, f);
  const before = await state(kit, f);
  expect(await save(kit, f, { payeeName: '错误姓名' })).toEqual({ code: 30307 });
  expect(await save(kit, f)).toEqual({ code: 30308 });
  expect(await save(kit, f, { alipayLogonId: 'free@example.com' })).toEqual({
    code: 30303,
    data: { reason: 'payout_account_change_limit' },
  });
  expect(await state(kit, f)).toEqual(before);
});

it('[AC-B1-13e#8] 同 App 当前绑定规范化后唯一；历史行与另一 App 不占用', async () => {
  const f = await fixture(kit);
  const owner = await fixture(kit, { appId: f.appId });
  await account(kit, owner, '13800138000');
  expect(await save(kit, f, { alipayLogonId: '8613800138000' })).toEqual({ code: 30308 });
  await kit.db
    .updateTable('payout_accounts')
    .set({ is_current: false })
    .where('user_id', '=', owner.uid)
    .execute();
  const otherApp = await fixture(kit);
  await account(kit, otherApp, '13800138000');
  expect((await save(kit, f, { alipayLogonId: '+86 138 0013 8000' })).code).toBe(0);
  expect((await state(kit, owner)).accounts[0]?.is_current).toBe(false);
  expect((await state(kit, otherApp)).accounts[0]?.is_current).toBe(true);
});

it('[AC-B1-13e#9] 换绑仅停用旧行、插新行并追加一条审计；旧密文与历史变更不改不删', async () => {
  const f = await fixture(kit);
  const old = await account(kit, f, 'old@example.com');
  const history = await change(kit, f, new Date('2026-09-20T00:00:00Z'));
  const result = await save(kit, f);
  expect(result).toMatchObject({ code: 0, data: { change_remaining_this_month: 1 } });
  const rows = await state(kit, f);
  expect(rows.accounts).toHaveLength(2);
  expect(rows.accounts.filter((row) => row.is_current)).toHaveLength(1);
  const former = rows.accounts.find((row) => row.id === old.id)!;
  const {
    is_current: oldCurrent,
    updated_at: oldUpdated,
    row_version: oldVersion,
    ...immutable
  } = old;
  void oldCurrent;
  void oldUpdated;
  void oldVersion;
  expect(former).toMatchObject({ ...immutable, is_current: false });
  expect(rows.changes).toHaveLength(2);
  expect(rows.changes[0]).toEqual(history);
  expect(rows.changes[1]).toMatchObject({
    app_id: f.appId,
    user_id: f.uid,
    old_payout_method: 'alipay',
    old_hmac: old.alipay_hmac,
    new_payout_method: 'alipay',
    new_hmac: kit.crypto.blindIndex(LOGIN, ALIPAY_CONTEXT),
    changed_at: kit.clock.now(),
    operator: expect.stringMatching(/\S/),
  });
});

it('[AC-B1-13e#10] 银行卡切支付宝共用计数，方法不同即使摘要碰巧相等也计次', async () => {
  const f = await fixture(kit);
  const digest = kit.crypto.blindIndex(LOGIN, ALIPAY_CONTEXT);
  await account(kit, f, '6222021234567890123', { method: 'bank_card', hmac: digest });
  await change(kit, f);
  expect(await save(kit, f)).toMatchObject({ code: 0, data: { change_remaining_this_month: 0 } });
  const rows = await state(kit, f);
  expect(rows.changes).toHaveLength(2);
  expect(rows.changes[1]).toMatchObject({
    old_payout_method: 'bank_card',
    new_payout_method: 'alipay',
    old_hmac: digest,
    new_hmac: digest,
  });
  expect(await save(kit, f, { alipayLogonId: 'third@example.com' })).toMatchObject({ code: 30303 });
});

it('[AC-B1-13e#11] 同账号在上限后仍成功，保留账号与变更记录；姓名与黑名单仍校验', async () => {
  const f = await fixture(kit);
  await account(kit, f, '13800138000');
  await change(kit, f);
  await change(kit, f);
  const before = await state(kit, f);
  const input = { alipayLogonId: '＋８６ １３８-００１３-８０００' };
  expect(await save(kit, f, input)).toEqual({
    code: 0,
    data: {
      payout_method: 'alipay',
      masked_account: '138****8000',
      masked_payee_name: MASKED_NAME,
      change_remaining_this_month: 0,
    },
  });
  expect(await state(kit, f)).toEqual(before);
  expect(await save(kit, f, { ...input, payeeName: '错误姓名' })).toEqual({ code: 30307 });
  await block(kit, f, '13800138000');
  expect(await save(kit, f, input)).toMatchObject({ code: 44001 });
  expect(await state(kit, f)).toEqual(before);
});

it('[AC-B1-13e#12] +08:00 自然月边界重置，历史不清零；只有本人本 App 当月记录计次', async () => {
  const f = await fixture(kit);
  const other = await fixture(kit, { appId: f.appId });
  await account(kit, f, 'old@example.com');
  await change(kit, f, new Date('2026-10-01T00:00:00Z'));
  await change(kit, f, new Date('2026-10-20T00:00:00Z'));
  await change(kit, other, new Date('2026-10-31T16:00:00Z'));
  kit.clock.set('2026-10-31T15:59:59.999Z');
  expect(await save(kit, f)).toMatchObject({ code: 30303 });
  kit.clock.set('2026-10-31T16:00:00.000Z');
  expect(await save(kit, f)).toMatchObject({ code: 0, data: { change_remaining_this_month: 1 } });
  expect((await state(kit, f)).changes).toHaveLength(3);
});

it('[AC-B1-13e#13] 方法配置关闭支付宝先回 20001 fields，恢复后按配置月上限计数', async () => {
  const f = await fixture(kit);
  await config(kit, f, 'withdraw.payout_methods', ['bank_card']);
  expect(await save(kit, f, { alipayLogonId: '@', payeeName: '错误姓名' })).toEqual({
    code: 20001,
    data: { fields: ['payout_method'] },
  });
  expect(await state(kit, f)).toEqual({ accounts: [], changes: [] });
  await config(kit, f, 'withdraw.payout_methods', ['alipay']);
  await config(kit, f, 'withdraw.payout_account_change_per_month', 1);
  expect(await save(kit, f)).toMatchObject({ code: 0, data: { change_remaining_this_month: 1 } });
  expect(await save(kit, f, { alipayLogonId: 'next@example.com' })).toMatchObject({
    code: 0,
    data: { change_remaining_this_month: 0 },
  });
  expect(await save(kit, f, { alipayLogonId: 'last@example.com' })).toMatchObject({ code: 30303 });
});

it.each([
  { methods: [], limit: -1 },
  { methods: ['invalid-private-config'], limit: 1.5 },
  { methods: 'alipay', limit: '3' },
  { methods: null, limit: null },
])('[AC-B1-13e#14] 非法配置退回默认并仅记录 config_key', async (values) => {
  const f = await fixture(kit);
  await config(kit, f, 'withdraw.payout_methods', values.methods);
  await config(kit, f, 'withdraw.payout_account_change_per_month', values.limit);
  kit.lines.length = 0;
  expect(await save(kit, f)).toMatchObject({ code: 0, data: { change_remaining_this_month: 2 } });
  const warnings = kit.lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['level'] === 40);
  expect(warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ config_key: 'withdraw.payout_methods' }),
      expect.objectContaining({ config_key: 'withdraw.payout_account_change_per_month' }),
    ]),
  );
  for (const warning of warnings.filter((line) => 'config_key' in line)) {
    expect(
      Object.keys(warning).filter(
        (key) =>
          !['level', 'time', 'pid', 'hostname', 'entry', 'env', 'msg', 'config_key'].includes(key),
      ),
    ).toEqual([]);
  }
  privateDataAbsent(kit, [], [NAME, LOGIN, 'invalid-private-config']);
});

it('[AC-B1-13e#15] 保存加入调用方事务：提交前外部不可见，调用方失败整笔回滚', async () => {
  const f = await fixture(kit);
  await account(kit, f, 'old@example.com');
  const before = await state(kit, f);
  const app = await service(kit);
  const rollback = new Error('fixture caller rollback');
  await expect(
    kit.db.transaction().execute(async (trx) => {
      expect((await app.save(trx, f.command)).code).toBe(0);
      const inside = await state(kit, f, trx);
      expect(inside.accounts).toHaveLength(2);
      expect(inside.changes).toHaveLength(1);
      expect(await state(kit, f)).toEqual(before);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await state(kit, f)).toEqual(before);
});
