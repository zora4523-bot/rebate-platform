// B1-27g · what an accepted correction writes about payout accounts (08 BR-WDR-02 细则「实名更正后的
// 失效与重绑」; BR-ID-25 细则「实名更正」; 04 §6.6「使该用户已绑定的收款账号全部失效（payout_accounts
// 不再有当前账号，写 payout_account_changes）」, §3.2 limit_exempt_reason; task §9.3, §9.4): in the
// overwrite's transaction every current payout account of the user stops being current and gets one
// payout_account_changes row with limit_exempt_reason = 'realname_correction', operator
// `admin:<操作员 id>`, changed_at = the Clock instant of the correction (old_* from the retired row,
// new_payout_method = its method, new_hmac = '', as B2-05j's createPayoutAccountInvalidation writes
// them); earlier accounts and change rows stay as they were; the audit's payout_accounts_invalidated
// is the number of rows retired.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  NEW,
  PERMISSION,
  added,
  audits,
  body,
  correct,
  identity,
  member,
  ok,
  user,
  verified,
  type User,
} from '../admin-realname/kit.ts';
import {
  EXEMPT,
  bound,
  change,
  changesOf,
  invalidatedIn,
  operatorOf,
  payoutState,
  setup,
} from './kit.ts';

const h = useHarness();

it.each([true, false])(
  '[AC-B1-27g#1] 支付宝当前账号（超管=%s）：一条 realname_correction 变更行，operator=admin:<id>、changed_at=更正时刻；无当前账号；审计失效数 1',
  async (isSuper) => {
    const s = await setup(h);
    const admin = isSuper ? undefined : await member(s, [PERMISSION]);
    const target = await user(h, s.appId);
    await verified(h, target);
    const history = await bound(h, target, 'bank_card', false, '6222021234567890123');
    const current = await bound(h, target, 'alipay', true, 'old.payee@example.com');
    const before = await audits(h, s.appId);
    const data = await ok(
      await correct(s, target.id, body(), admin === undefined ? {} : { as: admin }),
    );
    const now = s.clock.now();
    expect(new Date(data.verified_at).getTime()).toBe(now.getTime());

    const changes = await changesOf(h, target);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      app_id: s.appId,
      user_id: target.id,
      old_payout_method: 'alipay',
      old_hmac: current.alipay_hmac,
      new_payout_method: 'alipay',
      new_hmac: '',
      operator: operatorOf(admin?.who.id ?? s.actor.id),
      changed_at: now,
      limit_exempt_reason: EXEMPT,
    });

    const accounts = (await payoutState(h, target)).accounts;
    expect(accounts.filter((account) => account.is_current)).toEqual([]);
    expect(accounts.find((account) => account.id === history.id)).toEqual(history);
    expect(accounts.find((account) => account.id === current.id)).toEqual({
      ...current,
      is_current: false,
      row_version: current.row_version + 1,
      updated_at: now,
    });

    const rows = added(before, await audits(h, s.appId));
    expect(rows).toHaveLength(1);
    expect(invalidatedIn(rows[0]!)).toEqual([1]);
  },
);

it('[AC-B1-27g#2] 银行卡当前账号：变更行 old_payout_method=bank_card、old_hmac=bank_card_hmac、new_payout_method=bank_card、new_hmac 为空', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  const history = await bound(h, target, 'alipay', false, 'history.payee@example.com');
  const current = await bound(h, target, 'bank_card', true, '6222029876543210987');
  await ok(await correct(s, target.id, body()));
  const now = s.clock.now();
  const changes = await changesOf(h, target);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({
    old_payout_method: 'bank_card',
    old_hmac: current.bank_card_hmac,
    new_payout_method: 'bank_card',
    new_hmac: '',
    operator: operatorOf(s.actor.id),
    changed_at: now,
    limit_exempt_reason: EXEMPT,
  });
  const accounts = (await payoutState(h, target)).accounts;
  expect(accounts.filter((account) => account.is_current)).toEqual([]);
  expect(accounts.find((account) => account.id === history.id)).toEqual(history);
});

it('[AC-B1-27g#3] 变更行数 = 审计 payout_accounts_invalidated = 当前账号数：从未绑定 0、只剩历史账号 0、有当前账号 1', async () => {
  const s = await setup(h);
  const cases: { serial: string; arrange(target: User): Promise<unknown>; retired: number }[] = [
    { serial: '051', arrange: async () => undefined, retired: 0 },
    {
      serial: '052',
      arrange: (target) => bound(h, target, 'alipay', false, 'only.history@example.com'),
      retired: 0,
    },
    {
      serial: '053',
      arrange: (target) => bound(h, target, 'alipay', true, 'still.current@example.com'),
      retired: 1,
    },
  ];
  const seen: { retired: number; changes: unknown[]; invalidated: unknown[] }[] = [];
  for (const { serial, arrange, retired } of cases) {
    const target = await user(h, s.appId);
    await verified(h, target);
    await arrange(target);
    const was = await payoutState(h, target);
    const before = await audits(h, s.appId);
    // A distinct identity per user: the same number verified on two users is 30405.
    const who = identity(NEW.name, '440305', '1996-07-21', serial);
    await ok(await correct(s, target.id, body(who)));
    const after = await payoutState(h, target);
    const rows = added(before, await audits(h, s.appId));
    expect(rows).toHaveLength(1);
    expect(after.accounts.filter((account) => account.is_current)).toEqual([]);
    if (retired === 0) expect(after).toEqual(was);
    seen.push({
      retired,
      changes: after.changes.map((row) => row.limit_exempt_reason),
      invalidated: invalidatedIn(rows[0]!),
    });
  }
  expect(seen).toEqual([
    { retired: 0, changes: [], invalidated: [0] },
    { retired: 0, changes: [], invalidated: [0] },
    { retired: 1, changes: [EXEMPT], invalidated: [1] },
  ]);
});

it('[AC-B1-27g#4] 本月已有的普通变更行原样保留，exempt 行追加在其后；只追加这一条', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await verified(h, target);
  await bound(h, target, 'alipay', true, 'old.payee@example.com');
  const ordinary = [await change(h, target, s.clock.now()), await change(h, target, s.clock.now())];
  await ok(await correct(s, target.id, body()));
  const changes = await changesOf(h, target);
  expect(changes).toHaveLength(3);
  expect(changes.slice(0, 2)).toEqual(ordinary);
  expect(changes.map((row) => row.limit_exempt_reason)).toEqual([null, null, EXEMPT]);
});
