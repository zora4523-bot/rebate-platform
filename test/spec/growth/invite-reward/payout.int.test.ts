import { afterAll, beforeAll, expect, it } from 'vitest';
import { PostgresQueryCompiler } from 'kysely';
import { fixture, openDatabase, ready, warned, PAID, EXPIRES, IP, type Database } from './kit.ts';

let database: Database;
beforeAll(async () => {
  database = await openDatabase();
}, 180_000);
afterAll(async () => {
  await database?.close();
});

// BR-INV-24 examples: normal / old shared device / same IP / frozen inviter / O0 VOID /
// deferred then clawed back / switch off after qualification / already paid not clawed back;
// the effective-period example is AC #21, #31, #33, #34.
it('[AC-B1-35#40] 例：A/U 各得锁定 1000 分，总占用转已发、当日计 2000', async () => {
  const f = await fixture(database);
  await ready(f);
  f.settings.set('enabled', false);
  f.settings.set('amount_fen', 2000);
  f.settings.set('eligibility_days', 1);
  await f.process();
  const row = await f.row();
  expect(row).toMatchObject({
    status: 'processed',
    amount_fen: 1000n,
    eligibility_days: 30,
    inviter_result: 'granted',
    invitee_result: 'granted',
    inviter_skip_reason: null,
    invitee_skip_reason: null,
    granted_at: new Date(PAID),
  });
  expect(f.grants).toEqual(
    expect.arrayContaining([
      {
        app_id: f.appId,
        invitee_id: f.invitee,
        party: 'inviter',
        user_id: f.inviter,
        amount_fen: 1000n,
        at: new Date(PAID),
      },
      {
        app_id: f.appId,
        invitee_id: f.invitee,
        party: 'invitee',
        user_id: f.invitee,
        amount_fen: 1000n,
        at: new Date(PAID),
      },
    ]),
  );
  expect(f.grants).toHaveLength(2);
  expect(f.reads.filter((read) => read.kind === 'retained')).toEqual([
    {
      kind: 'retained',
      transactional: true,
      input: { app_id: f.appId, user_id: f.invitee, at: new Date(PAID) },
    },
  ]);
  const vouchers = await f.vouchers();
  expect(vouchers.map((v) => v.id).sort()).toEqual(
    [row?.inviter_voucher_id, row?.invitee_voucher_id].sort(),
  );
  expect(await f.budget()).toMatchObject({ reserved_fen: 0n, granted_fen: 2000n });
  expect(await f.budget('2026-11-25')).toMatchObject({ granted_fen: 2000n, reserved_fen: 0n });
  expect(f.judgements).toEqual(
    expect.arrayContaining([
      { user: f.inviter, id: f.invitee, party: 'inviter' },
      { user: f.invitee, id: f.invitee, party: 'invitee' },
    ]),
  );
});

it.each(['same_device', 'same_ip', 'deleted_phone_retained'] as const)(
  '[AC-B1-35#41] 双方防刷 %s 按优先级终止，两方不发并释放全部占用',
  async (reason) => {
    const f = await fixture(database);
    await ready(f);
    f.retained.add(f.invitee);
    if (reason !== 'deleted_phone_retained') f.ips.set(f.inviter, [IP]);
    if (reason === 'same_device') {
      f.deviceSets.set(f.inviter, ['old-device']);
      f.deviceSets.set(f.invitee, ['old-device']);
    }
    await f.process();
    expect(await f.row()).toMatchObject({
      status: 'processed',
      inviter_result: 'skipped',
      invitee_result: 'skipped',
      inviter_skip_reason: reason,
      invitee_skip_reason: reason,
      inviter_voucher_id: null,
      invitee_voucher_id: null,
    });
    expect(await f.budget()).toMatchObject({ reserved_fen: 0n, granted_fen: 0n });
    expect(f.grants).toEqual([]);
    f.retained.clear();
    f.ips.clear();
    f.deviceSets.clear();
    await f.process();
    expect(f.grants).toEqual([]);
  },
);

it.each(['inviter', 'invitee'] as const)(
  '[AC-B1-35#42] 该方 %s 命中单方防刷，另一方照发；解除后不补发',
  async (party) => {
    // Decision-table rows include every restricted risk state, deletion state, minor and mark.
    for (const kind of [
      'banned',
      'appealing',
      'frozen',
      'processing',
      'done',
      'minor',
      'multi_account',
    ] as const) {
      const f = await fixture(database);
      await ready(f);
      const uid = party === 'inviter' ? f.inviter : f.invitee;
      if (kind === 'banned' || kind === 'appealing' || kind === 'frozen') f.risks.set(uid, kind);
      else if (kind === 'processing' || kind === 'done') f.deleting.set(uid, kind);
      else if (kind === 'minor') f.birthdays.set(uid, '2010-11-26');
      else f.marked.add(uid);
      const reason = ['banned', 'appealing', 'frozen'].includes(kind)
        ? 'risk_restricted'
        : ['processing', 'done'].includes(kind)
          ? 'deleting'
          : kind;
      await f.process();
      const other = party === 'inviter' ? 'invitee' : 'inviter';
      expect(await f.row()).toMatchObject({
        status: 'processed',
        [`${party}_result`]: 'skipped',
        [`${party}_skip_reason`]: reason,
        [`${other}_result`]: 'granted',
      });
      expect(f.grants).toHaveLength(1);
      expect(f.grants[0]?.party).toBe(other);
      expect(await f.budget()).toMatchObject({ reserved_fen: 0n, granted_fen: 1000n });
      expect(await f.budget('2026-11-25')).toMatchObject({ granted_fen: 1000n });
      f.risks.clear();
      f.deleting.clear();
      f.birthdays.clear();
      f.marked.clear();
      await f.process();
      expect(f.grants).toHaveLength(1);
    }
  },
);

it.each(['deleting', 'risk_restricted', 'minor', 'multi_account'] as const)(
  '[AC-B1-35#43] 单方多个命中时首因 %s，不把另一方一起拒绝',
  async (reason) => {
    const f = await fixture(database);
    await ready(f);
    f.marked.add(f.inviter);
    if (reason !== 'multi_account') f.birthdays.set(f.inviter, '2010-01-01');
    if (reason === 'deleting' || reason === 'risk_restricted') f.risks.set(f.inviter, 'banned');
    if (reason === 'deleting') f.deleting.set(f.inviter, 'processing');
    await f.process();
    expect(await f.row()).toMatchObject({
      status: 'processed',
      inviter_skip_reason: reason,
      invitee_result: 'granted',
    });
    expect(f.grants).toHaveLength(1);
  },
);

it('[AC-B1-35#44] 身份年龄在发放时判，恰满 18 岁可以发', async () => {
  const f = await fixture(database);
  await ready(f);
  // BR-ID-26: 18 is reached at 00:00 (+08:00) the day after the 18th birthday. Processing runs at
  // PAID (2026-11-25 10:00 +08:00): born 2008-11-24 is exactly 18, born 2008-11-25 is still a minor.
  f.birthdays.set(f.inviter, '2008-11-24');
  f.birthdays.set(f.invitee, '2008-11-25');
  await f.process();
  expect(await f.row()).toMatchObject({
    inviter_result: 'granted',
    invitee_result: 'skipped',
    invitee_skip_reason: 'minor',
  });
  expect(f.grants).toHaveLength(1);
});

it.each([
  'relation_changed',
  'relation_changed_to_other',
  'clawed_back',
  'partial_refund',
  'not_credited',
  'rights_pending',
  'rights_row',
] as const)('[AC-B1-35#45] 发放前 %s 作废，释放预算、不再接受下一笔订单', async (kind) => {
  const f = await fixture(database);
  const order = await ready(f);
  let reason = 'order_clawed_back';
  if (kind === 'relation_changed' || kind === 'relation_changed_to_other') {
    const parent = kind === 'relation_changed_to_other' ? await f.user() : null;
    await f.db
      .updateTable('users')
      .set({ parent_id: parent })
      .where('app_id', '=', f.appId)
      .where('id', '=', f.invitee)
      .execute();
    // Keep the other-parent case CREDITED: it must fail solely on the changed relation.
    if (kind === 'relation_changed') order.rebate_status = 'CLAWED_BACK';
    reason = 'relation_changed';
  } else if (kind === 'clawed_back') order.rebate_status = 'CLAWED_BACK';
  else if (kind === 'partial_refund') order.refunded_quantity = 1;
  else if (kind === 'not_credited') order.rebate_status = 'WAITING';
  else {
    if (kind === 'rights_pending') order.rights_pending = true;
    else order.has_rights = true;
    reason = 'order_rights';
  }
  await f.process();
  expect(await f.row()).toMatchObject({ status: 'voided', void_reason: reason });
  expect(await f.budget()).toMatchObject({ reserved_fen: 0n, granted_fen: 0n });
  expect(f.grants).toEqual([]);
  const later = await f.order();
  await f.trigger(later.order_id);
  await f.process();
  expect(await f.row()).toMatchObject({ status: 'voided', trigger_order_id: order.order_id });
  expect(f.grants).toEqual([]);
});

it('[AC-B1-35#46] 已发奖励之后退款不追回，终态重放不修改预算或凭证', async () => {
  const f = await fixture(database);
  const order = await ready(f);
  await f.process();
  const before = await f.row();
  const vouchers = await f.vouchers();
  order.rebate_status = 'CLAWED_BACK';
  order.refunded_quantity = 1;
  await f.process();
  expect(await f.row()).toEqual(before);
  expect(await f.vouchers()).toEqual(vouchers);
  expect(await f.budget()).toMatchObject({ reserved_fen: 0n, granted_fen: 2000n });
  expect(f.grants).toHaveLength(2);
});

it('[AC-B1-35#47] 防御期外触发单清空触发，不作废不发放并告警', async () => {
  const f = await fixture(database);
  await ready(f, { attr_at: new Date(EXPIRES) });
  await f.process();
  expect(await f.row()).toMatchObject({
    status: 'qualified',
    trigger_order_id: null,
    triggered_at: null,
  });
  expect(await f.budget()).toMatchObject({ reserved_fen: 2000n, granted_fen: 0n });
  expect(f.grants).toEqual([]);
  warned(f);
});

it('[AC-B1-35#48] 没资格或未触发资格不写结果、不花预算', async () => {
  const f = await fixture(database);
  await f.process();
  expect(await f.row()).toBeUndefined();
  await f.seedReward();
  await f.process();
  expect(await f.row()).toMatchObject({ status: 'qualified', row_version: 0 });
  expect(await f.budget()).toMatchObject({ reserved_fen: 2000n, granted_fen: 0n });
  expect(f.grants).toEqual([]);
});

it('[AC-B1-35#49] 同一奖励并发 process 每方只调用一次写入', async () => {
  const f = await fixture(database);
  await ready(f);
  await Promise.all(Array.from({ length: 8 }, () => f.process()));
  expect(await f.row()).toMatchObject({ status: 'processed' });
  expect(f.grants).toHaveLength(2);
  expect(await f.vouchers()).toHaveLength(2);
  expect(await f.budget()).toMatchObject({ reserved_fen: 0n, granted_fen: 2000n });
  expect(await f.budget('2026-11-25')).toMatchObject({ granted_fen: 2000n });
});

it('[AC-B1-35#50] 第二方凭证失败，第一方凭证、当日预算和总预算一并回滚', async () => {
  const f = await fixture(database);
  await ready(f);
  const writer = f.deps.grantWriter!;
  const error = new Error('fixture writer failure');
  let calls = 0;
  f.deps.grantWriter = {
    grant: async (trx, input) => {
      if (++calls === 2) throw error;
      return writer.grant(trx, input);
    },
  };
  const before = await f.row();
  await expect(f.process()).rejects.toBe(error);
  expect(await f.row()).toEqual(before);
  expect(await f.vouchers()).toEqual([]);
  expect(await f.budget()).toMatchObject({ reserved_fen: 2000n, granted_fen: 0n });
  expect((await f.budget('2026-11-25'))?.granted_fen ?? 0n).toBe(0n);
  f.deps.grantWriter = writer;
  await f.process();
  expect(await f.vouchers()).toHaveLength(2);
});

it('[AC-B1-35#51] 释放时占用不足必须回滚本条，不能产生负预算或假终态', async () => {
  const f = await fixture(database);
  await ready(f);
  f.retained.add(f.invitee);
  await f.db
    .updateTable('invite_reward_budgets')
    .set({ reserved_fen: 1999n })
    .where('app_id', '=', f.appId)
    .execute();
  const before = await f.row();
  await expect(f.process()).rejects.toThrow();
  expect(await f.row()).toEqual(before);
  expect(await f.budget()).toMatchObject({ reserved_fen: 1999n, granted_fen: 0n });
  expect(f.grants).toEqual([]);
  warned(f, 50);
});

it('[AC-B1-35#52] IP 窗口以绑定时刻为锚，不随延迟发放滑动，坏值回落 24h', async () => {
  const f = await fixture(database);
  await ready(f);
  f.settings.set('ip_window_hours', '24');
  await f.process();
  expect(f.reads).toContainEqual({
    kind: 'ip',
    transactional: true,
    input: {
      app_id: f.appId,
      user_id: f.inviter,
      from: new Date('2026-10-19T02:00:00Z'),
      to: new Date('2026-10-20T02:00:00Z'),
    },
  });
  expect(f.grants).toHaveLength(2);
  warned(f);
});

it('[AC-B1-35#53] 发放锁顺序 users → invite_rewards → total → 当日，避免与月结互锁', async () => {
  const f = await fixture(database);
  await ready(f);
  const queries: string[] = [];
  f.deps.db = f.db.withPlugin({
    transformQuery({ node, queryId }) {
      queries.push(new PostgresQueryCompiler().compileQuery(node, queryId).sql);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  await f.process();
  expect(await f.row()).toMatchObject({ status: 'processed' });
  const locks = queries.filter((q) => /\bfor (?:no key )?update\b/i.test(q));
  const userLock = locks.findIndex((q) => /"users"/.test(q));
  const rewardLock = locks.findIndex((q) => /"invite_rewards"/.test(q));
  const budgetLock = locks.findIndex((q) => /"invite_reward_budgets"/.test(q));
  expect(userLock).toBeGreaterThanOrEqual(0);
  expect(rewardLock).toBeGreaterThan(userLock);
  expect(budgetLock).toBeGreaterThan(rewardLock);
});

it('[AC-B1-35#54] 发放按 app_id 隔离，不读取另一应用同一用户的资格', async () => {
  const f = await fixture(database);
  await ready(f);
  const service = (await import('./kit.ts')).growth;
  const payout = (await service()).createInviteRewardPayout(f.deps);
  await payout.process(`other_${f.appId}`, f.invitee);
  expect(await f.row()).toMatchObject({ status: 'qualified' });
  expect(f.grants).toEqual([]);
  await payout.process(f.appId, f.invitee);
  expect(await f.row()).toMatchObject({ status: 'processed' });
  expect(f.grants).toHaveLength(2);
});

it('[AC-B1-35#55] 邀请人窗口内登录 IP 与绑定 IP 不同，两方照发、不记 same_ip', async () => {
  const f = await fixture(database);
  await ready(f);
  f.ips.set(f.inviter, ['2001:db8::2', '203.0.113.88']);
  await f.process();
  expect(f.reads.filter((read) => read.kind === 'ip')).toHaveLength(1);
  expect(await f.row()).toMatchObject({
    status: 'processed',
    inviter_result: 'granted',
    invitee_result: 'granted',
    inviter_skip_reason: null,
    invitee_skip_reason: null,
  });
  expect(f.grants).toHaveLength(2);
  expect(await f.budget()).toMatchObject({ reserved_fen: 0n, granted_fen: 2000n });
});
