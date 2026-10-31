// B1-03zf (编排 D10-495 FU-APPEAL-RESTORE-PRICING, 上线门槛 GATE-APPEAL-RESTORE-PRICING; B2-09ga money 评审
// 范围外 S1): a share forfeited for the ban whose FORFEIT voucher the ledger does not have — R5 credited
// it held while the member was frozen (first_credit obligation open), the member was then banned and
// an R9 partial refund closed the obligation as forfeited and appended forfeited(banned), booking no
// FORFEIT voucher — no longer makes the whole revoked ban appeal reject (retry, then dead letter, and
// none of the member's shares restored). The injected FORFEIT amount port answers null for it: the
// sub-order's appeal_restore difference is registered as usual, that share counted 0 in expected_fen
// and marked in resolution.shares with amount_source = no_forfeit_voucher for the handler side
// (admin ADMIN_RESTORE, B2-09ga) to recompute on the server. Shares with a voucher keep the voucher's
// amount. A port that is not injected at all (an assembly error) still rejects and logs
// appeal_restore_amount_unavailable (B1-03z). Fixtures are B1-03z's (db-kit.ts: synthetic rows only).
// Top-level it() only.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createAppealRestoreHandler,
  type AppealRestoreLogger,
} from '../../../../apps/api/src/modules/risk/application/appeal-restore.ts';
import {
  PORTS,
  expectRestore,
  openSuite,
  scenario,
  type Scenario,
  type Suite,
} from '../appeal-restore/db-kit.ts';
import { IN_BAN_1, IN_BAN_2 } from '../appeal-restore/kit.ts';

/** R5: the share was credited held while the member was frozen, before this ban began (PENALTY_AT). */
const FROZEN_CREDIT_AT = new Date('2026-09-08T00:00:00.000Z');
/** The marker of a share without a FORFEIT voucher (编排 D10-495 9.2 ①). */
const NO_VOUCHER = 'no_forfeit_voucher';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

/**
 * Delivers and answers the error message, null when the delivery resolved. Asserted with
 * toBeNull, so a handler that still rejects fails on an assertion (the rejection is its message).
 */
async function failureOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function deliver(f: Scenario, received: ReturnType<Scenario['event']>): Promise<string | null> {
  const handler = f.handler();
  return failureOf(() => f.db.transaction().execute((trx) => handler(received, trx)));
}

type Row = Awaited<ReturnType<Scenario['diffs']>>[number];
type ResolutionShare = { role?: unknown; amount_fen?: unknown; amount_source?: unknown };

function resolutionOf(row: Row | undefined): Record<string, unknown> {
  const value = row?.resolution;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sharesOf(row: Row | undefined): ResolutionShare[] {
  const shares = resolutionOf(row)['shares'];
  return Array.isArray(shares) ? (shares as ResolutionShare[]) : [];
}

it('[B1-03zf 无凭证份额] R5 冻结 held → 封禁 → R9 部分退款关成 forfeited(banned)、未写 FORFEIT 凭证，另一订单的份额有凭证 → 撤销封禁申诉不拒绝、不进死信：两条差错单照常登记，无凭证那份 expected 0 并标明 amount_source = no_forfeit_voucher，有凭证那份按凭证金额；重放不重复登记，不入账', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const buyer = await f.user();
  // R5: the member's direct share was credited held while frozen; banned later, R9's partial
  // refund closed it forfeited(banned) without a FORFEIT voucher.
  const refunded = await f.order([
    { userId: buyer, role: 'self', amountFen: 500n },
    { userId: member, role: 'direct', amountFen: 85n },
  ]);
  await f.shareEvent(refunded, member, 'direct', 'held', null, FROZEN_CREDIT_AT);
  await f.forfeit(refunded, { userId: member, role: 'direct' }, 'banned', IN_BAN_2, null);
  // An ordinary forfeiture of this ban, FORFEIT voucher booked 425 to the platform.
  const credited = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  await f.forfeit(credited, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  const appeal = await f.appeal({ userId: member });
  const before = await f.untouched();

  expect(await deliver(f, f.event(appeal))).toBeNull();

  const rows = await f.diffs();
  expect(rows).toHaveLength(2);
  expectRestore(rows[0], f, {
    appealId: appeal.id,
    orderId: refunded,
    userId: member,
    role: 'direct',
    amountFen: 0n,
  });
  expect(resolutionOf(rows[0])).toMatchObject({
    appeal_id: appeal.id,
    order_id: refunded,
    user_id: member,
  });
  expect(sharesOf(rows[0])).toEqual([
    expect.objectContaining({ role: 'direct', amount_fen: '0', amount_source: NO_VOUCHER }),
  ]);
  expectRestore(rows[1], f, {
    appealId: appeal.id,
    orderId: credited,
    userId: member,
    role: 'self',
    amountFen: 425n,
  });
  expect(sharesOf(rows[1])).toEqual([expect.objectContaining({ role: 'self', amount_fen: '425' })]);
  expect(sharesOf(rows[1])[0]?.amount_source).not.toBe(NO_VOUCHER);

  // At least once: the same event again and a new event id register nothing new.
  f.clock.set('2026-09-26T03:00:00.000Z');
  expect(await deliver(f, f.event(appeal))).toBeNull();
  expect(await deliver(f, f.event(appeal, randomUUID()))).toBeNull();
  expect(await f.diffs()).toEqual(rows);
  // 处理前不入账: no voucher, entry, balance, share event or appeal written.
  expect(await f.untouched()).toEqual(before);
});

it('[B1-03zf 无凭证份额] 同一子订单上会员两个角色：一份有凭证（310）、一份无凭证 → 仍合为一条，expected = 有凭证那份 310（无凭证那份按 0 计入），去重键含两个角色，resolution.shares 逐角色列明细、无凭证那份标明 no_forfeit_voucher', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const order = await f.order([
    { userId: member, role: 'share', amountFen: 300n },
    { userId: member, role: 'direct', amountFen: 85n },
  ]);
  await f.forfeit(order, { userId: member, role: 'share' }, 'banned', IN_BAN_1, 310n);
  await f.shareEvent(order, member, 'direct', 'held', null, FROZEN_CREDIT_AT);
  await f.forfeit(order, { userId: member, role: 'direct' }, 'banned', IN_BAN_2, null);
  const appeal = await f.appeal({ userId: member });

  expect(await deliver(f, f.event(appeal))).toBeNull();

  const rows = await f.diffs();
  expect(rows).toHaveLength(1);
  expectRestore(rows[0], f, {
    appealId: appeal.id,
    orderId: order,
    userId: member,
    role: ['direct', 'share'],
    amountFen: 310n,
  });
  const shares = sharesOf(rows[0]);
  expect(shares).toHaveLength(2);
  expect(shares).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'share', amount_fen: '310' }),
      expect.objectContaining({ role: 'direct', amount_fen: '0', amount_source: NO_VOUCHER }),
    ]),
  );
  expect(shares.find((s) => s.role === 'share')?.amount_source).not.toBe(NO_VOUCHER);
});

it('[B1-03zf 无凭证份额] 一个子订单上会员的全部被没收份额都没有 FORFEIT 凭证 → 不跳过、不拒绝：仍登记一条，expected 0 / actual 0 / diff 0，每份都标明 no_forfeit_voucher 交处理端服务端重算', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const order = await f.order([
    { userId: member, role: 'share', amountFen: 300n },
    { userId: member, role: 'direct', amountFen: 85n },
  ]);
  await f.forfeit(order, { userId: member, role: 'share' }, 'banned', IN_BAN_1, null);
  await f.forfeit(order, { userId: member, role: 'direct' }, 'banned', IN_BAN_2, null);
  const appeal = await f.appeal({ userId: member });
  const before = await f.untouched();

  expect(await deliver(f, f.event(appeal))).toBeNull();
  expect(await deliver(f, f.event(appeal, randomUUID()))).toBeNull();

  const rows = await f.diffs();
  expect(rows).toHaveLength(1);
  expectRestore(rows[0], f, {
    appealId: appeal.id,
    orderId: order,
    userId: member,
    role: ['direct', 'share'],
    amountFen: 0n,
  });
  expect(resolutionOf(rows[0])).toMatchObject({ order_id: order, user_id: member });
  const shares = sharesOf(rows[0]);
  expect(shares).toHaveLength(2);
  expect(shares).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'share', amount_fen: '0', amount_source: NO_VOUCHER }),
      expect.objectContaining({ role: 'direct', amount_fen: '0', amount_source: NO_VOUCHER }),
    ]),
  );
  expect(await f.untouched()).toEqual(before);
});

it('[B1-03zf 装配错误仍拒绝] FORFEIT 金额端口未注入 → 仍拒绝、记 error appeal_restore_amount_unavailable、不登记；装配修好后（端口已注入、对该份额答 null）重投同一申诉 → 照常登记 expected 0 并标明 no_forfeit_voucher', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const order = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  await f.forfeit(order, { userId: member, role: 'self' }, 'banned', IN_BAN_1, null);
  const appeal = await f.appeal({ userId: member });
  const before = await f.untouched();
  const error = vi.fn<AppealRestoreLogger['error']>();
  const miswired = createAppealRestoreHandler({
    clock: f.clock,
    shares: PORTS.shares,
    bannedRunStart: PORTS.bannedRunStart,
    logger: { error },
  });

  await expect(
    f.db.transaction().execute((trx) => miswired(f.event(appeal), trx)),
  ).rejects.toThrow();
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({ app_id: f.appId, appeal_id: appeal.id }),
    'appeal_restore_amount_unavailable',
  );
  expect(await f.diffs()).toEqual([]);
  expect(await f.untouched()).toEqual(before);

  expect(await deliver(f, f.event(appeal, randomUUID()))).toBeNull();

  const rows = await f.diffs();
  expect(rows).toHaveLength(1);
  expectRestore(rows[0], f, {
    appealId: appeal.id,
    orderId: order,
    userId: member,
    role: 'self',
    amountFen: 0n,
  });
  expect(sharesOf(rows[0])).toEqual([
    expect.objectContaining({ role: 'self', amount_fen: '0', amount_source: NO_VOUCHER }),
  ]);
  expect(await f.untouched()).toEqual(before);
});
