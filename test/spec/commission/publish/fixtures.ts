// 合成数据；生命周期仅在 *.int.test.ts。固定样本不借助待测服务生成。
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { splitCommission, type RuleVersionRow } from '@couli/domain';
import type { Kysely } from 'kysely';
import { vi } from 'vitest';
import type {
  CreateRuleDraftInput,
  RulePublicationDependencies,
} from '../../../../apps/api/src/modules/commission/application/rule-publication.ts';
import type { AuditPort } from '../../../../apps/api/src/modules/platform/audit/port.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';

// 避免 test 的 TS 工程静态载入 Nest 装饰器图；运行时仍从模块唯一公开出口调用。
export const service = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as Pick<
  typeof import('../../../../apps/api/src/modules/commission/application/rule-publication.ts'),
  'createDraft' | 'validateDraft' | 'runTrial' | 'publish' | 'revoke'
>;

export const NOW = '2030-06-12T12:00:00+08:00';
export const START = '2030-06-05T12:00:00+08:00';
export const BASE_TIME = '2030-06-01T00:00:00+08:00';
export const FUTURE = '2030-06-13T12:00:00+08:00';
export const PLATFORMS = ['taobao', 'jd', 'pdd'] as const;

export function draftInput(overrides: Partial<CreateRuleDraftInput> = {}): CreateRuleDraftInput {
  return {
    appId: `publication-${randomUUID()}`,
    actor: { adminUserId: randomUUID() },
    baseVersionId: null,
    effectiveFrom: new Date(FUTURE),
    indirectEnabled: true,
    rules: PLATFORMS.flatMap((platform) =>
      (['L1', 'L2', 'L3'] as const).flatMap((level) =>
        (['self', 'share'] as const).map((order_type): RuleVersionRow => ({
          platform,
          level,
          order_type,
          r_own_bp: 5000n,
          r_direct_bp: 1000n,
          r_indirect_bp: 500n,
        })),
      ),
    ),
    reserves: PLATFORMS.map((platform) => ({ platform, reserve_bp: 1000n })),
    ...overrides,
  };
}

export function dependencies() {
  const clock = new FixedClock(NOW);
  const append = vi.fn<AuditPort['append']>(async () => {});
  const deps: RulePublicationDependencies = { clock, platforms: PLATFORMS, audit: { append } };
  return { clock, append, deps };
}

export async function seedActor(db: Kysely<DB>, input: CreateRuleDraftInput) {
  await db
    .withSchema('app')
    .insertInto('admin_users')
    .values({
      app_id: input.appId,
      id: input.actor.adminUserId,
      login_name: `synthetic-${input.actor.adminUserId}`,
      password_hash: 'synthetic-unused',
      is_super: true,
      status: 'active',
    })
    .execute();
}

export async function seedVersion(
  db: Kysely<DB>,
  input: CreateRuleDraftInput,
  options: { status?: 'draft' | 'published' | 'revoked'; effective?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const app = db.withSchema('app');
  await app
    .insertInto('commission_rule_versions')
    .values({
      app_id: input.appId,
      rule_version_id: id,
      status: options.status ?? 'draft',
      effective_from: options.effective ?? input.effectiveFrom,
      indirect_enabled: input.indirectEnabled,
      base_version_id: input.baseVersionId,
      drafter_id: input.actor.adminUserId,
      publisher_id: options.status === 'published' ? input.actor.adminUserId : null,
      published_at: options.status === 'published' ? BASE_TIME : null,
      revoked_at: options.status === 'revoked' ? BASE_TIME : null,
      created_at: BASE_TIME,
    })
    .execute();
  if (input.rules.length)
    await app
      .insertInto('commission_rules')
      .values(
        input.rules.map((r) => ({
          ...r,
          app_id: input.appId,
          rule_version_id: id,
          r_own_bp: Number(r.r_own_bp),
          r_direct_bp: Number(r.r_direct_bp),
          r_indirect_bp: Number(r.r_indirect_bp),
          created_at: BASE_TIME,
        })),
      )
      .execute();
  if (input.reserves.length)
    await app
      .insertInto('commission_rule_reserves')
      .values(
        input.reserves.map((r) => ({
          ...r,
          reserve_bp: Number(r.reserve_bp),
          app_id: input.appId,
          rule_version_id: id,
          created_at: BASE_TIME,
        })),
      )
      .execute();
  return id;
}

export async function setup(db: Kysely<DB>, overrides: Partial<CreateRuleDraftInput> = {}) {
  const original = draftInput();
  await seedActor(db, original);
  const baseId = await seedVersion(db, original, { status: 'published', effective: BASE_TIME });
  const input = { ...original, baseVersionId: baseId, ...overrides };
  const draftId = await seedVersion(db, input);
  return {
    ...dependencies(),
    input,
    baseId,
    draftId,
    context: { appId: input.appId, actor: input.actor, draftId },
  };
}

/** 记录全行用于拒绝零写入/历史不变断言，不只比计数。 */
export async function stored(db: Kysely<DB>, appId: string) {
  const app = db.withSchema('app');
  const [versions, rules, reserves, trials, splits, amounts] = await Promise.all([
    app
      .selectFrom('commission_rule_versions')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('rule_version_id')
      .execute(),
    app
      .selectFrom('commission_rules')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('rule_version_id')
      .orderBy('platform')
      .orderBy('level')
      .orderBy('order_type')
      .execute(),
    app
      .selectFrom('commission_rule_reserves')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('rule_version_id')
      .orderBy('platform')
      .execute(),
    app
      .selectFrom('commission_rule_trials')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('trial_id')
      .execute(),
    app
      .selectFrom('commission_splits')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('order_id')
      .execute(),
    app
      .selectFrom('commission_split_amounts')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('order_id')
      .orderBy('commission_version')
      .orderBy('role')
      .execute(),
  ]);
  return { versions, rules, reserves, trials, splits, amounts };
}

export async function seedSample(
  db: Kysely<DB>,
  input: CreateRuleDraftInput,
  baseId: string,
  options: {
    paidAt?: string;
    platform?: string;
    snapshot?: boolean;
    orderType?: 'self' | 'share';
    n?: bigint;
  } = {},
) {
  const orderId = randomUUID();
  const paidAt = options.paidAt ?? START;
  const app = db.withSchema('app');
  await app
    .insertInto('order_keys')
    .values({
      app_id: input.appId,
      order_id: orderId,
      platform: options.platform ?? 'taobao',
      sub_order_id: `synthetic-${orderId}`,
      attr_at: paidAt,
    })
    .execute();
  if (options.snapshot === false) return orderId;
  const orderType = options.orderType ?? 'self';
  const people = [
    {
      user_id: randomUUID(),
      role: orderType,
      ratio_bp: 5000,
      level: 'L1',
      initial_status: 'active',
      forfeit_reason: null,
    },
    {
      user_id: randomUUID(),
      role: 'direct',
      ratio_bp: 1000,
      level: 'L2',
      initial_status: 'active',
      forfeit_reason: null,
    },
    {
      user_id: randomUUID(),
      role: 'indirect',
      ratio_bp: 500,
      level: 'L3',
      initial_status: 'active',
      forfeit_reason: null,
    },
  ];
  const split = splitCommission({
    n_base_fen: options.n ?? 1234n,
    reserve_bp: 1000n,
    tlj_deduct_fen: 0n,
    order_type: orderType,
    indirect_enabled: true,
    owner: { user_id: people[0]!.user_id, ratio_bp: 5000n, status: 'active' },
    direct: { user_id: people[1]!.user_id, ratio_bp: 1000n, status: 'active' },
    indirect: { user_id: people[2]!.user_id, ratio_bp: 500n, status: 'active' },
  });
  await app
    .insertInto('commission_splits')
    .values({
      app_id: input.appId,
      order_id: orderId,
      rule_version_id: baseId,
      order_type: orderType,
      activity_type: null,
      rebate_mode: null,
      paid_at: paidAt,
      paid_at_source: 'platform',
      raw_n_fen: options.n ?? 1234n,
      subsidy_commission_fen: 0n,
      reserve_bp: 1000,
      reserve_fen: split.reserve_fen,
      tlj_deduct_fen: 0n,
      base_fen: split.base_fen,
      platform_retain_fen: split.platform_retain_fen,
      beneficiaries: JSON.stringify(people),
      created_at: NOW,
    })
    .execute();
  await app
    .insertInto('commission_split_amounts')
    .values(
      people.map((p, i) => ({
        app_id: input.appId,
        order_id: orderId,
        commission_version: 1,
        user_id: p.user_id,
        role: p.role,
        base_fen: split.base_fen,
        amount_fen: split.shares[i]!.amount_fen,
        created_at: NOW,
      })),
    )
    .execute();
  return orderId;
}
