// B1-09p · 后台订单详情（真实 admin 入口）：display_status 与所有者本人视角一致（BR-FUND-17，查看者
// 是订单所有者）；AdminOrderDetail 没有金额字段，不新增。骨架上后台仍按未知数据派生，所以红在断言。
import { expect, it } from 'vitest';
import { NOW, useHarness } from '../../admin/auth/kit.ts';
import { detail, setup, type Scenario } from '../admin-orders-read/kit.ts';
import { credited, fixture, waiting, type Fixture, type SeededOrder } from './kit.ts';

const h = useHarness();
const TIMEOUT = 60_000;
/** The user-side figures; the console detail has none of them (contract AdminOrderDetail). */
const USER_FIGURES = [
  'est_rebate_fen',
  'actual_fen',
  'clawback_fen',
  'expected_credit_period',
  'credit_overdue',
  'appeal_pending',
];

async function scenario() {
  const s = await setup(h);
  const f = await fixture(h.db, { now: NOW, subject: { app_id: s.appId, user_id: s.userId } });
  return { s, f };
}

async function adminStatus(s: Scenario, o: SeededOrder) {
  return detail(await s.get({}, o.orderId));
}

async function ownerStatus(f: Fixture, o: SeededOrder) {
  return (await f.detail(o))?.display_status;
}

it(
  '[AC-B1-09p#60][BR-FUND-17][D10-558] 所有者本人有 CLAWBACK：后台是部分扣回，别的受益人的扣回不算，详情无金额字段',
  async () => {
    const { s, f } = await scenario();
    const parent = await f.user();
    const people = [
      { userId: s.userId, role: 'self', ratioBp: 5000 },
      { userId: parent, role: 'direct', ratioBp: 1000 },
    ] as const;
    const own = await f.order({ patch: credited(), people });
    await f.credit(own, { amount: 425n });
    await f.clawback(own, { amount: 100n });
    const others = await f.order({ patch: credited(), people });
    await f.credit(others, { amount: 425n });
    await f.credit(others, { amount: 85n, userId: parent, role: 'direct' });
    await f.clawback(others, { amount: 20n, userId: parent, role: 'direct' });

    const seen = await adminStatus(s, own);
    expect(seen.display_status).toBe('CREDITED_PART_CLAWED');
    for (const field of USER_FIGURES) expect(seen).not.toHaveProperty(field);
    expect(seen.display_status).toBe(await ownerStatus(f, own));

    expect((await adminStatus(s, others)).display_status).toBe('CREDITED');
    expect(await ownerStatus(f, others)).toBe('CREDITED');
  },
  TIMEOUT,
);

it(
  '[AC-B1-09p#61][BR-FUND-17] B_est=0：后台是本单无返利，B_est 为空的单仍是已付款',
  async () => {
    const { s, f } = await scenario();
    const empty = await f.order({ patch: { est_commission_fen: 0n } });
    const unknown = await f.order({ patch: { est_commission_fen: null } });
    expect((await adminStatus(s, empty)).display_status).toBe('NO_REBATE');
    expect(await ownerStatus(f, empty)).toBe('NO_REBATE');
    expect((await adminStatus(s, unknown)).display_status).toBe('PAID');
    expect(await ownerStatus(f, unknown)).toBe('PAID');
  },
  TIMEOUT,
);

it(
  '[AC-B1-09p#62][BR-FUND-17] 所有者本人份额暂缓：后台也是 REVIEWING，别的受益人暂缓不算',
  async () => {
    const { s, f } = await scenario();
    const parent = await f.user();
    const people = [
      { userId: s.userId, role: 'self', ratioBp: 5000 },
      { userId: parent, role: 'direct', ratioBp: 1000 },
    ] as const;
    const held = await f.order({ patch: credited(), people });
    await f.obligation(held, { kind: 'first_credit' });
    const others = await f.order({ patch: credited(), people });
    await f.credit(others, { amount: 425n });
    await f.obligation(others, { kind: 'first_credit', userId: parent, role: 'direct' });
    expect((await adminStatus(s, held)).display_status).toBe('REVIEWING');
    expect(await ownerStatus(f, held)).toBe('REVIEWING');
    expect((await adminStatus(s, others)).display_status).toBe('CREDITED');
  },
  TIMEOUT,
);

it(
  '[AC-B1-09p#63][BR-FUND-04][BR-FUND-17] 逾期：后台是 CREDITING，未到期仍是 WAITING，时刻走注入 Clock',
  async () => {
    const { s, f } = await scenario();
    // NOW is 2026-10-09: settle_period 2026-07 → 2026-08 → deadline 2026-09-03, already past.
    const overdue = await f.order({ patch: waiting({ settle_period: '2026-07' }) });
    const current = await f.order({ patch: waiting({ settle_period: '2026-09' }) });
    expect((await adminStatus(s, overdue)).display_status).toBe('CREDITING');
    expect(await ownerStatus(f, overdue)).toBe('CREDITING');
    expect((await adminStatus(s, current)).display_status).toBe('WAITING');
    expect(await ownerStatus(f, current)).toBe('WAITING');
  },
  TIMEOUT,
);
