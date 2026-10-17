// 合成数据；不模拟平台报文，不读取真实身份日志。数据库生命周期只在 *.int.test.ts。
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { vi } from 'vitest';
import type {
  CommissionSnapshotDependencies,
  CreateCommissionSnapshotInput,
  SnapshotBeneficiaries,
  SnapshotBeneficiaryResolver,
} from '../../../../apps/api/src/modules/commission/application/snapshot.ts';
import type { RuleVersion } from '../../../../apps/api/src/modules/commission/domain/rules.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';

// 与已有 commission 测试相同：运行时经公开出口，避免 test 项目载入 Nest 装饰器图。
export const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  createCommissionSnapshot: typeof import('../../../../apps/api/src/modules/commission/application/snapshot.ts').createCommissionSnapshot;
};

export const CREATED_AT = new Date('2030-06-12T11:22:33.456+08:00');

export function input(
  overrides: Partial<CreateCommissionSnapshotInput> = {},
): CreateCommissionSnapshotInput {
  return {
    appId: `snapshot-${randomUUID()}`,
    orderId: randomUUID(),
    platform: 'taobao',
    paidAt: new Date('2026-10-20T10:00:00+08:00'),
    paidAtSource: 'platform',
    orderType: 'self',
    activityType: null,
    rebateMode: null,
    nBaseFen: 1234n,
    subsidyCommissionFen: 0n,
    tljDeductFen: 0n,
    tljRedpacketFen: 0n,
    ownerUserId: randomUUID(),
    ...overrides,
  };
}

export function beneficiaries(ownerUserId: string): SnapshotBeneficiaries {
  return {
    owner: { userId: ownerUserId, level: 'L1', status: 'active', forfeitReason: null },
    direct: { userId: randomUUID(), level: 'L2', status: 'active', forfeitReason: null },
    indirect: { userId: randomUUID(), level: 'L3', status: 'active', forfeitReason: null },
    warnings: [],
  };
}

export function dependencies(people: SnapshotBeneficiaries) {
  const resolve = vi.fn<SnapshotBeneficiaryResolver['resolve']>(async () => people);
  const warn = vi.fn<CommissionSnapshotDependencies['logger']['warn']>();
  const clock = new FixedClock(CREATED_AT);
  const deps: CommissionSnapshotDependencies = {
    clock,
    logger: { warn },
    beneficiaries: { resolve },
  };
  return { deps, resolve, warn, clock };
}

export function version(overrides: Partial<RuleVersion> = {}): RuleVersion {
  return {
    rule_version_id: randomUUID(),
    effective_from: new Date('2026-10-01T00:00:00+08:00'),
    indirect_enabled: true,
    rules: (['taobao', 'jd', 'pdd'] as const).flatMap((platform) =>
      (['L1', 'L2', 'L3'] as const).flatMap((level) =>
        (['self', 'share'] as const).map((order_type) => ({
          platform,
          level,
          order_type,
          r_own_bp: 5000,
          r_direct_bp: 1000,
          r_indirect_bp: 500,
        })),
      ),
    ),
    reserves: (['taobao', 'jd', 'pdd'] as const).map((platform) => ({ platform, reserve_bp: 0 })),
    ...overrides,
  };
}

export async function seedOrder(
  db: Kysely<DB>,
  order: CreateCommissionSnapshotInput,
): Promise<void> {
  await db
    .withSchema('app')
    .insertInto('order_keys')
    .values({
      app_id: order.appId,
      order_id: order.orderId,
      platform: order.platform,
      sub_order_id: `synthetic-${order.orderId}`,
      attr_at: order.paidAt,
    })
    .execute();
}

export async function seedVersion(
  db: Kysely<DB>,
  appId: string,
  v: RuleVersion,
  status: 'published' | 'draft' | 'revoked' = 'published',
  revokedAt: Date | null = null,
): Promise<void> {
  const app = db.withSchema('app');
  await app
    .insertInto('commission_rule_versions')
    .values({
      app_id: appId,
      rule_version_id: v.rule_version_id,
      status,
      effective_from: v.effective_from,
      indirect_enabled: v.indirect_enabled,
      revoked_at: revokedAt,
    })
    .execute();
  if (v.rules.length > 0)
    await app
      .insertInto('commission_rules')
      .values(v.rules.map((r) => ({ ...r, app_id: appId, rule_version_id: v.rule_version_id })))
      .execute();
  if (v.reserves.length > 0)
    await app
      .insertInto('commission_rule_reserves')
      .values(v.reserves.map((r) => ({ ...r, app_id: appId, rule_version_id: v.rule_version_id })))
      .execute();
}

export async function readRows(db: Kysely<DB>, order: CreateCommissionSnapshotInput) {
  const app = db.withSchema('app');
  const [splits, amounts, events, totals] = await Promise.all([
    app
      .selectFrom('commission_splits')
      .selectAll()
      .where('app_id', '=', order.appId)
      .where('order_id', '=', order.orderId)
      .execute(),
    app
      .selectFrom('commission_split_amounts')
      .selectAll()
      .where('app_id', '=', order.appId)
      .where('order_id', '=', order.orderId)
      .orderBy('role')
      .orderBy('user_id')
      .execute(),
    app
      .selectFrom('commission_split_beneficiary_events')
      .selectAll()
      .where('app_id', '=', order.appId)
      .where('order_id', '=', order.orderId)
      .orderBy('event_seq')
      .execute(),
    app
      .selectFrom('commission_split_totals')
      .selectAll()
      .where('app_id', '=', order.appId)
      .where('order_id', '=', order.orderId)
      .execute(),
  ]);
  return { splits, amounts, events, totals };
}
