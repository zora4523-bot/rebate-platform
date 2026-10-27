// BR-WDR-30 ①–⑥ ⑧ ⑩–⑬ as the consumer reads them (⑦ ⑨ are in counts.int.test.ts): every input
// is taken from the database or the ports at the decision, under the locks, and the exact
// failed_conditions land in auto_decision (B2-11b compares; this task feeds it).
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  MINUTE,
  NOW,
  TIMEOUT,
  close,
  decision,
  key,
  open,
  setup,
  type AutoFixture,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

/** One delivery of `id`'s withdrawal.created; the auto_decision written. */
async function judge(f: AutoFixture, id: string) {
  await f.consumer().consume(await f.event(id));
  return (await f.row(id)).auto_decision;
}

it('[AC-B2-11c#10] ① 总开关在判定时为关（W1 时为开）→ manual，failed_conditions 只记 disabled，即使其他条件也不满足', async () => {
  const f = await setup(h);
  const id = await f.start(35_000n);
  f.minors.add(f.actor.userId);
  await f.set(key('enabled'), false);
  expect(await judge(f, id)).toEqual(decision('manual', ['disabled']));
  expect(await f.row(id)).toMatchObject({ status: 'PENDING_REVIEW', review_mode: 'manual' });
  expect(f.execute).not.toHaveBeenCalled();
});

it('[AC-B2-11c#11] ③ 时段限制 on 且 10:00 不在 [11:00:00, 22:59:59] → outside_window；限制 off 时同一时段不生效；闭区间起点 10:00:00 放行', async () => {
  const f = await setup(h);
  await f.set(key('window_start'), '11:00:00');
  await f.set(key('window_end'), '22:59:59');
  await f.set(key('window_limit_enabled'), true);
  expect(await judge(f, await f.start(100n))).toEqual(decision('manual', ['outside_window']));

  const off = await setup(h);
  await off.set(key('window_start'), '11:00:00');
  await off.set(key('window_end'), '22:59:59');
  await off.set(key('window_limit_enabled'), false);
  expect(await judge(off, await off.start(100n))).toEqual(decision('auto', []));

  const edge = await setup(h);
  await edge.set(key('window_start'), '10:00:00');
  await edge.set(key('window_end'), '10:59:59');
  await edge.set(key('window_limit_enabled'), true);
  expect(await judge(edge, await edge.start(100n))).toEqual(decision('auto', []));
});

it('[AC-B2-11c#12] ③ 时刻取 created_at（+08:00）而非判定时刻：10:00 申请、11:30 才判定，时段 [10:00:00, 10:59:59] 仍放行', async () => {
  const f = await setup(h);
  await f.set(key('window_start'), '10:00:00');
  await f.set(key('window_end'), '10:59:59');
  await f.set(key('window_limit_enabled'), true);
  const id = await f.start(100n);
  const later = new Date(NOW.getTime() + 90 * MINUTE);
  f.clock.set(later);
  expect(await judge(f, id)).toEqual(decision('auto', [], {}, later));
});

it('[AC-B2-11c#13] ④ 首提限制 on：没有 PAID_API / PAID_MANUAL 的会员 → first_withdrawal；已有一笔人工到账则放行；限制 off 时首提也放行', async () => {
  const f = await setup(h);
  await f.set(key('first_withdrawal_limit_enabled'), true);
  expect(await judge(f, await f.start(100n))).toEqual(decision('manual', ['first_withdrawal']));

  const paid = await setup(h);
  await paid.set(key('first_withdrawal_limit_enabled'), true);
  await paid.seedReviewed({
    userId: paid.actor.userId,
    status: 'PAID_MANUAL',
    reviewMode: 'manual',
    reviewedAt: new Date('2026-09-01T02:00:00.000Z'),
  });
  expect(await judge(paid, await paid.start(100n))).toEqual(decision('auto', []));

  const off = await setup(h);
  expect(await judge(off, await off.start(100n))).toEqual(decision('auto', []));
});

it('[AC-B2-11c#14] ⑤(a) 生效的 withdraw_holds → frozen_balance，且会员有提现阻断故 ⑬ w2_guard 同记；已解除或 hold_until 已过的不算', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  await f.seedHold(f.actor.userId);
  expect(await judge(f, id)).toEqual(decision('manual', ['frozen_balance', 'w2_guard']));
  expect((await f.row(id)).status).toBe('PENDING_REVIEW');

  const released = await setup(h);
  const second = await released.start(100n);
  await released.seedHold(released.actor.userId, { released: true });
  await released.seedHold(released.actor.userId, { holdUntil: new Date(NOW.getTime() - MINUTE) });
  expect(await judge(released, second)).toEqual(decision('auto', []));
});

it.each([
  ['frozen', null, ['frozen_balance', 'w2_guard']],
  ['appealing', 'frozen', ['frozen_balance', 'w2_guard']],
  ['banned', null, ['w2_guard']],
] as const)(
  '[AC-B2-11c#15] ⑤(a) / ⑬ 判定时再查 risk_state=%s（申诉前状态 %s）→ %j',
  async (state, prev, failed) => {
    const f = await setup(h);
    const id = await f.start(100n);
    f.risk.set(f.actor.userId, { state, frozen_until: null });
    if (prev !== null) f.appeals.set(f.actor.userId, prev);
    expect(await judge(f, id)).toEqual(decision('manual', [...failed]));
    expect(f.execute).not.toHaveBeenCalled();
  },
);

it('[AC-B2-11c#16] ⑤(b) 该会员 frozen_fen > 本单 amount_fen（另有未完结提现单占用冻结额）→ frozen_balance；只有本单冻结时放行', async () => {
  const f = await setup(h);
  const first = await f.start(100n);
  const second = await f.start(100n);
  expect(await judge(f, second)).toEqual(decision('manual', ['frozen_balance']));

  const alone = await setup(h);
  expect(await judge(alone, await alone.start(100n))).toEqual(decision('auto', []));
  expect((await f.row(first)).auto_decision).toBeNull();
});

it('[AC-B2-11c#17] ⑥ 申请当日 00:00（+08:00）至 created_at 有 REBATE_CREDIT 入账 → same_day', async () => {
  const f = await setup(h);
  await f.post(1n, new Date('2026-10-19T01:00:00.000Z'), 'REBATE_CREDIT');
  expect(await judge(f, await f.start(100n))).toEqual(decision('manual', ['same_day']));
});

it('[AC-B2-11c#18] ⑥ 窗口是 created_at 所在自然日的 00:00 至 created_at：前一日 23:59:59.999 的入账、申请之后才到的入账都不算', async () => {
  const f = await setup(h);
  await f.post(1n, new Date('2026-10-18T15:59:59.999Z'), 'REBATE_CREDIT');
  expect(await judge(f, await f.start(100n))).toEqual(decision('auto', []));

  const g = await setup(h);
  const id = await g.start(100n);
  await g.post(1n, new Date(NOW.getTime() + MINUTE), 'REBATE_CREDIT');
  const later = new Date(NOW.getTime() + 2 * MINUTE);
  g.clock.set(later);
  expect(await judge(g, id)).toEqual(decision('auto', [], {}, later));
});

it('[AC-B2-11c#19] ⑧ W 非 0 时启用：确认收货佣金为 0（分母 0）→ warn_withdraw_received；Y、Z 非 0 但没有订单（分母 0）不命中；三项实际值写入 warn_values', async () => {
  const f = await setup(h);
  await f.set(key('warn.withdraw_received_ratio_bp'), 5000);
  await f.set(key('warn.high_commission_order_ratio_bp'), 1);
  await f.set(key('warn.invalid_ratio_bp'), 1);
  expect(await judge(f, await f.start(100n))).toEqual(
    decision('manual', ['warn_withdraw_received']),
  );
});

it('[AC-B2-11c#20] ⑩ 未满 18 周岁 → minor', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  f.minors.add(f.actor.userId);
  expect(await judge(f, id)).toEqual(decision('manual', ['minor']));
});

it('[AC-B2-11c#21] ⑪ 快照收款方式的通道未开通：payout.channel_enabled.alipay=false → channel_disabled', async () => {
  const f = await setup(h);
  await f.set('payout.channel_enabled.alipay', false);
  expect(await judge(f, await f.start(100n))).toEqual(decision('manual', ['channel_disabled']));
});

it('[AC-B2-11c#22] 08 例：银行卡收款、银行卡通道未配置（默认 off）→ channel_disabled；通道开通后放行', async () => {
  const f = await setup(h, { method: 'bank_card' });
  expect(await judge(f, await f.start(100n))).toEqual(decision('manual', ['channel_disabled']));

  const on = await setup(h, { method: 'bank_card' });
  await on.set('payout.channel_enabled.bank_card', true);
  expect(await judge(on, await on.start(100n))).toEqual(decision('auto', []));
});

it('[AC-B2-11c#23] 08 例 ⑫：W1 快照 risk_flags 含 had_negative（默认阻断集合）→ risk_flag:had_negative；含 risk_calc_failed 同样阻断', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  await f.seedRiskFlags(id, [
    { code: 'first_withdrawal', value: true, threshold: null },
    { code: 'had_negative', value: true, threshold: null },
  ]);
  expect(await judge(f, id)).toEqual(decision('manual', ['risk_flag:had_negative']));

  const g = await setup(h);
  const failed = await g.start(100n);
  await g.seedRiskFlags(failed, [
    { code: 'risk_calc_failed', value: ['credited_today'], threshold: null },
  ]);
  expect(await judge(g, failed)).toEqual(decision('manual', ['risk_flag:risk_calc_failed']));
});

it('[AC-B2-11c#24] ⑫ risk_block_flags 取配置：改成 [first_withdrawal] 后 first_withdrawal 阻断、had_negative 放行；不在集合里的标签只供审核参考', async () => {
  const f = await setup(h);
  await f.set(key('risk_block_flags'), ['first_withdrawal']);
  const id = await f.start(100n);
  await f.seedRiskFlags(id, [
    { code: 'first_withdrawal', value: true, threshold: null },
    { code: 'had_negative', value: true, threshold: null },
  ]);
  expect(await judge(f, id)).toEqual(decision('manual', ['risk_flag:first_withdrawal']));

  const empty = await setup(h);
  await empty.set(key('risk_block_flags'), []);
  const other = await empty.start(100n);
  await empty.seedRiskFlags(other, [{ code: 'had_negative', value: true, threshold: null }]);
  expect(await judge(empty, other)).toEqual(decision('auto', []));
});

it('[AC-B2-11c#25] ⑫ blacklist_hit 在判定时实时检查且不可移除：risk_block_flags 为空时仍阻断', async () => {
  const f = await setup(h);
  await f.set(key('risk_block_flags'), []);
  const id = await f.start(100n);
  f.blacklisted.add(f.actor.userId);
  expect(await judge(f, id)).toEqual(decision('manual', ['risk_flag:blacklist_hit']));
});

it('[AC-B2-11c#26] ⑬ 锁内余额 available_fen < 0 → w2_guard，不做系统 W2', async () => {
  const f = await setup(h, { balance: 1_000n });
  const id = await f.start(100n);
  await f.post(-901n, new Date('2026-10-18T02:00:00.000Z'), 'ADMIN_ADJUST');
  expect(await judge(f, id)).toEqual(decision('manual', ['w2_guard']));
  expect(await f.row(id)).toMatchObject({ status: 'PENDING_REVIEW', reviewer_id: null });
  expect(await f.approvals(id)).toEqual([]);
});

it('[AC-B2-11c#27] ⑬ blocked_reason 非空 → w2_guard', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  await sql`UPDATE app.withdrawals SET blocked_reason = 'NEGATIVE_BALANCE' WHERE id = ${id}`.execute(
    h.db,
  );
  expect(await judge(f, id)).toEqual(decision('manual', ['w2_guard']));
  expect(f.execute).not.toHaveBeenCalled();
});

it('[AC-B2-11c#28] ①–⑬ 全部检查不短路：金额超限、未成年、通道关、黑名单同时不满足时按序全部记录', async () => {
  const f = await setup(h);
  await f.set('payout.channel_enabled.alipay', false);
  const id = await f.start(35_000n);
  f.minors.add(f.actor.userId);
  f.blacklisted.add(f.actor.userId);
  expect(await judge(f, id)).toEqual(
    decision('manual', ['max_amount', 'minor', 'channel_disabled', 'risk_flag:blacklist_hit']),
  );
});
