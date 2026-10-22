// 合成数据；期望金额在各用例中写死，不调用待测算法生成期望。
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { addFen, applyReserve, splitByBp, subFen } from '@couli/money';
import type { Insertable, Kysely } from 'kysely';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import {
  createPendingEarningsSource,
  type PendingEarningsDependencies,
} from '../../../../apps/api/src/modules/settlement/reads/pending-earnings.ts';
import { commission } from '../../commission/snapshot-read/fixtures.ts';

export const AT = new Date('2026-10-20T01:00:00Z');

export interface Person {
  userId: string;
  role: 'self' | 'share' | 'direct' | 'indirect';
  ratioBp: number;
  initialStatus?: 'active' | 'forfeited';
  forfeitReason?: string;
  forfeitedEvent?: { reason: string; at: Date };
}

export interface Scope {
  appId: string;
  userId: string;
  ruleVersionId: string;
}

export async function scope(db: Kysely<DB>): Promise<Scope> {
  const f = {
    appId: `pending-${randomUUID()}`,
    userId: randomUUID(),
    ruleVersionId: randomUUID(),
  };
  await db
    .withSchema('app')
    .insertInto('commission_rule_versions')
    .values({
      app_id: f.appId,
      rule_version_id: f.ruleVersionId,
      status: 'published',
      effective_from: AT,
      indirect_enabled: true,
      created_at: AT,
    })
    .execute();
  return f;
}

export interface OrderOptions {
  order?: Partial<Insertable<DB['orders']>>;
  people?: readonly Person[];
  reserveBp?: number;
  tljDeductFen?: bigint;
}

export async function seed(db: Kysely<DB>, f: Scope, options: OrderOptions = {}) {
  const app = db.withSchema('app');
  const orderId = randomUUID();
  const people = options.people ?? [{ userId: f.userId, role: 'self', ratioBp: 5000 }];
  const reserveBp = options.reserveBp ?? 1500;
  const tljDeductFen = options.tljDeductFen ?? 0n;
  // 初始快照始终以 N=1000 建立，订单当前佣金可不同：读取必须重算而非复用旧份额。
  const reserve = applyReserve(1000n, BigInt(reserveBp));
  const afterDeduct = subFen(reserve.after_reserve_fen, tljDeductFen);
  const base = afterDeduct > 0n ? afterDeduct : 0n;
  const allocation = splitByBp(
    base,
    people.map((p) => (p.initialStatus === 'forfeited' ? 0n : BigInt(p.ratioBp))),
  );
  const total = allocation.shares.reduce((sum, share) => addFen(sum, share), 0n);
  const order = {
    order_id: orderId,
    app_id: f.appId,
    platform: 'taobao',
    sub_order_id: `synthetic-${orderId}`,
    raw_item_id: 'synthetic-item',
    user_id: f.userId,
    platform_status: 'PAID',
    rebate_status: 'ESTIMATED',
    attr_at: AT,
    paid_at: AT,
    est_commission_fen: 1000n,
    settle_commission_fen: null,
    commission_version: 1,
    ...options.order,
  } satisfies Insertable<DB['orders']>;
  if (typeof order.user_id === 'string') {
    await app
      .insertInto('users')
      .values({
        id: order.user_id,
        app_id: order.app_id,
        nickname: 'synthetic',
        avatar: '',
        invite_code: order.user_id,
        attr_code: order.user_id,
        level: 'member',
        register_method: 'synthetic',
        created_at: AT,
        updated_at: AT,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }
  await app
    .insertInto('order_keys')
    .values({
      app_id: order.app_id,
      order_id: order.order_id,
      platform: order.platform,
      sub_order_id: order.sub_order_id,
      attr_at: order.attr_at,
    })
    .execute();
  await app.insertInto('orders').values(order).execute();
  await app
    .insertInto('commission_splits')
    .values({
      app_id: f.appId,
      order_id: order.order_id,
      rule_version_id: f.ruleVersionId,
      order_type: people[0]?.role === 'share' ? 'share' : 'self',
      paid_at: AT,
      paid_at_source: 'platform',
      raw_n_fen: 1000n,
      subsidy_commission_fen: 0n,
      reserve_bp: reserveBp,
      reserve_fen: reserve.reserve_fen,
      tlj_deduct_fen: tljDeductFen,
      base_fen: base,
      platform_retain_fen: allocation.remainder,
      activity_type: tljDeductFen > 0n ? 'tlj' : null,
      rebate_mode: tljDeductFen > 0n ? 'normal' : null,
      beneficiaries: JSON.stringify(
        people.map((p) => ({
          user_id: p.userId,
          role: p.role,
          ratio_bp: p.ratioBp,
          level: 'L1',
          initial_status: p.initialStatus ?? 'active',
          forfeit_reason: p.initialStatus === 'forfeited' ? (p.forfeitReason ?? 'deleted') : null,
        })),
      ),
      created_at: AT,
    })
    .execute();
  await app
    .insertInto('commission_split_totals')
    .values({
      app_id: f.appId,
      order_id: order.order_id,
      commission_version: 1,
      n_total_fen: 1000n,
      pre_base_deduct_fen: subFen(1000n, base),
      base_fen: base,
      user_share_total_fen: total,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: subFen(1000n, total),
      created_at: AT,
    })
    .execute();
  await app
    .insertInto('commission_split_amounts')
    .values(
      people.map((p, i) => ({
        app_id: f.appId,
        order_id: order.order_id,
        commission_version: 1,
        user_id: p.userId,
        role: p.role,
        base_fen: base,
        amount_fen: allocation.shares[i]!,
        created_at: AT,
      })),
    )
    .execute();
  for (const p of people) {
    if (!p.forfeitedEvent) continue;
    await app
      .insertInto('commission_split_beneficiary_events')
      .values({
        app_id: f.appId,
        order_id: order.order_id,
        user_id: p.userId,
        role: p.role,
        status: 'forfeited',
        reason: p.forfeitedEvent.reason,
        created_at: p.forfeitedEvent.at,
      })
      .execute();
  }
  return order.order_id;
}

export function harness(config: Record<string, unknown> = {}, at = '2026-10-22T01:00:00Z') {
  const clock = new FixedClock(at);
  const values: Record<string, unknown> = {
    'credit.enabled.taobao': true,
    'credit.enabled.jd': true,
    'credit.enabled.pdd': true,
    ...config,
  };
  const deps: PendingEarningsDependencies = {
    clock,
    config: { get: async (_appId, key) => values[key] },
    readSnapshot: commission.readCommissionSnapshot,
    // 仅测试适配器直读夹具；生产端口必须由 commission 提供，不能照抄跨模块 SQL。
    readTljDeductFen: async (trx, input) => {
      const row = await trx
        .withSchema('app')
        .selectFrom('commission_splits')
        .select('tlj_deduct_fen')
        .where('app_id', '=', input.appId)
        .where('order_id', '=', input.orderId)
        .executeTakeFirstOrThrow();
      return row.tlj_deduct_fen;
    },
  };
  return { clock, values, deps, source: () => createPendingEarningsSource(deps) };
}

export const emptyUser = {
  estimated_total_fen: 0n,
  estimated_fen: 0n,
  pending_credit_fen: 0n,
  pending_credit_paused_fen: 0n,
  next_credit_period: null,
  credit_overdue: false,
};
