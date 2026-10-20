// 合成数据库行；不调用快照写入实现或分佣算法生成期望。
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { subFen } from '@couli/money';
import type { Kysely } from 'kysely';
import type {
  ReadCommissionSnapshotInput,
  ReadSnapshotBeneficiary,
} from '../../../../apps/api/src/modules/commission/application/read-snapshot.ts';

// 经公开出口运行；与同模块已有规则测试一致，避免 test 的 tsc 引入 Nest 装饰器图。
export const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  readCommissionSnapshot: typeof import('../../../../apps/api/src/modules/commission/application/read-snapshot.ts').readCommissionSnapshot;
};

export const AT = new Date('2026-10-20T01:00:00Z');
export const EARLIER = new Date('2026-10-19T01:00:00Z');

export interface Fixture {
  input: ReadCommissionSnapshotInput;
  ruleVersionId: string;
  people: ReadSnapshotBeneficiary[];
}

export function fixture(): Fixture {
  return {
    input: { appId: `snapshot-read-${randomUUID()}`, orderId: randomUUID(), commissionVersion: 1 },
    ruleVersionId: randomUUID(),
    people: [
      {
        userId: randomUUID(),
        role: 'self',
        ratioBp: 5000,
        level: 'L1',
        initialStatus: 'active',
        forfeitReason: null,
      },
      {
        userId: randomUUID(),
        role: 'direct',
        ratioBp: 1000,
        level: 'L2',
        initialStatus: 'active',
        forfeitReason: null,
      },
      {
        userId: randomUUID(),
        role: 'indirect',
        ratioBp: 500,
        level: 'L3',
        initialStatus: 'active',
        forfeitReason: null,
      },
    ],
  };
}

export async function seed(
  db: Kysely<DB>,
  f: Fixture,
  initialAmounts: readonly bigint[] = [425n, 85n, 42n],
  initialUserTotal: bigint = 552n,
  initialRetain: bigint = 298n,
): Promise<void> {
  const app = db.withSchema('app');
  await app
    .insertInto('order_keys')
    .values({
      app_id: f.input.appId,
      order_id: f.input.orderId,
      platform: 'taobao',
      sub_order_id: `synthetic-${f.input.orderId}`,
      attr_at: AT,
    })
    .execute();
  await app
    .insertInto('commission_rule_versions')
    .values({
      app_id: f.input.appId,
      rule_version_id: f.ruleVersionId,
      status: 'published',
      effective_from: EARLIER,
      indirect_enabled: true,
      created_at: EARLIER,
    })
    .execute();
  // 故意不种现行规则或用户行：读取端口只依赖已持久化快照。
  await app
    .insertInto('commission_splits')
    .values({
      app_id: f.input.appId,
      order_id: f.input.orderId,
      rule_version_id: f.ruleVersionId,
      order_type: f.people[0]?.role === 'share' ? 'share' : 'self',
      activity_type: null,
      rebate_mode: null,
      paid_at: AT,
      paid_at_source: 'platform',
      raw_n_fen: 1000n,
      subsidy_commission_fen: 0n,
      reserve_bp: 1500,
      reserve_fen: 150n,
      tlj_deduct_fen: 0n,
      base_fen: 850n,
      platform_retain_fen: initialRetain,
      beneficiaries: JSON.stringify(
        f.people.map((p) => ({
          user_id: p.userId,
          role: p.role,
          ratio_bp: p.ratioBp,
          level: p.level,
          initial_status: p.initialStatus,
          forfeit_reason: p.forfeitReason,
        })),
      ),
      created_at: AT,
    })
    .execute();
  await appendVersion(db, f, 1, 850n, 1000n, initialAmounts, initialUserTotal, AT);
  for (const p of f.people) {
    await event(db, f, p, p.initialStatus, p.forfeitReason, AT);
  }
}

export async function appendVersion(
  db: Kysely<DB>,
  f: Fixture,
  version: number,
  base: bigint,
  n: bigint,
  amounts: readonly bigint[],
  userTotal: bigint,
  at: Date,
): Promise<void> {
  const app = db.withSchema('app');
  await app
    .insertInto('commission_split_totals')
    .values({
      app_id: f.input.appId,
      order_id: f.input.orderId,
      commission_version: version,
      n_total_fen: n,
      pre_base_deduct_fen: subFen(n, base),
      base_fen: base,
      user_share_total_fen: userTotal,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: subFen(n, userTotal),
      created_at: at,
    })
    .execute();
  await app
    .insertInto('commission_split_amounts')
    .values(
      f.people.map((p, i) => ({
        app_id: f.input.appId,
        order_id: f.input.orderId,
        commission_version: version,
        user_id: p.userId,
        role: p.role,
        base_fen: base,
        amount_fen: amounts[i]!,
        created_at: at,
      })),
    )
    .execute();
}

export async function event(
  db: Kysely<DB>,
  f: Fixture,
  p: ReadSnapshotBeneficiary,
  status: 'active' | 'held' | 'forfeited',
  reason: string | null,
  at: Date,
) {
  const row = await db
    .withSchema('app')
    .insertInto('commission_split_beneficiary_events')
    .values({
      app_id: f.input.appId,
      order_id: f.input.orderId,
      user_id: p.userId,
      role: p.role,
      status,
      reason,
      created_at: at,
    })
    .returning('event_seq')
    .executeTakeFirstOrThrow();
  return { eventSeq: row.event_seq, userId: p.userId, role: p.role, reason };
}

export async function rows(db: Kysely<DB>, f: Fixture) {
  const app = db.withSchema('app');
  return {
    splits: await app
      .selectFrom('commission_splits')
      .selectAll()
      .where('order_id', '=', f.input.orderId)
      .where('app_id', '=', f.input.appId)
      .execute(),
    totals: await app
      .selectFrom('commission_split_totals')
      .selectAll()
      .where('order_id', '=', f.input.orderId)
      .where('app_id', '=', f.input.appId)
      .orderBy('commission_version')
      .execute(),
    amounts: await app
      .selectFrom('commission_split_amounts')
      .selectAll()
      .where('order_id', '=', f.input.orderId)
      .where('app_id', '=', f.input.appId)
      .orderBy('commission_version')
      .orderBy('user_id')
      .orderBy('role')
      .execute(),
    events: await app
      .selectFrom('commission_split_beneficiary_events')
      .selectAll()
      .where('order_id', '=', f.input.orderId)
      .where('app_id', '=', f.input.appId)
      .orderBy('event_seq')
      .execute(),
  };
}
