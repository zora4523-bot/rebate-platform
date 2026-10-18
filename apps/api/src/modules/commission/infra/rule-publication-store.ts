// B2-03k: Kysely access of the rule publication service, always inside the caller's transaction.
// Writes only this module's tables: commission_rule_versions (insert drafts; update status,
// publisher_id, published_at, revoked_at — the only columns couli_app may update, 0032),
// commission_rules / commission_rule_reserves (insert with the draft) and commission_rule_trials
// (insert only, 0043). Reads the snapshot sample from commission_splits /
// commission_split_amounts and the order platform from order_keys. No SQL clock: every timestamp
// comes from the injected Clock.
import type { DB } from '@couli/db';
import type { RuleVersionReserve, RuleVersionRow } from '@couli/domain';
import type { Selectable, Transaction } from 'kysely';
import type { RuleReserve, RuleRow, RuleVersion } from '../domain/rules.ts';

export type VersionRow = Selectable<DB['commission_rule_versions']>;
export type TrialRow = Selectable<DB['commission_rule_trials']>;
export type SplitRow = Selectable<DB['commission_splits']> & { readonly platform: string };
export type AmountRow = Selectable<DB['commission_split_amounts']>;

/**
 * BR-CALC-11 / BR-CALC-22: FOR UPDATE on every version row of the app, in a fixed order (no
 * deadlock between two publishers). Conflicts with the snapshot writer's FOR SHARE on the
 * published rows until the caller commits; other apps' rows are not touched.
 */
export async function lockAppVersions(trx: Transaction<DB>, appId: string): Promise<void> {
  await trx
    .withSchema('app')
    .selectFrom('commission_rule_versions')
    .select('rule_version_id')
    .where('app_id', '=', appId)
    .orderBy('rule_version_id')
    .forUpdate()
    .execute();
}

/** All version rows of the app (a fresh statement: sees what committed while the lock waited). */
export async function readAppVersions(trx: Transaction<DB>, appId: string): Promise<VersionRow[]> {
  return trx
    .withSchema('app')
    .selectFrom('commission_rule_versions')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('rule_version_id')
    .execute();
}

export async function findVersion(
  trx: Transaction<DB>,
  appId: string,
  ruleVersionId: string,
): Promise<VersionRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('commission_rule_versions')
    .selectAll()
    .where('app_id', '=', appId)
    .where('rule_version_id', '=', ruleVersionId)
    .executeTakeFirst();
}

export interface VersionContent {
  readonly rules: RuleRow[];
  readonly reserves: RuleReserve[];
}

/** The ratio rows and reserves of one version of the app, in a stable order. */
export async function readVersionContent(
  trx: Transaction<DB>,
  appId: string,
  ruleVersionId: string,
): Promise<VersionContent> {
  const app = trx.withSchema('app');
  const rules = await app
    .selectFrom('commission_rules')
    .select(['platform', 'level', 'order_type', 'r_own_bp', 'r_direct_bp', 'r_indirect_bp'])
    .where('app_id', '=', appId)
    .where('rule_version_id', '=', ruleVersionId)
    .orderBy('platform')
    .orderBy('level')
    .orderBy('order_type')
    .execute();
  const reserves = await app
    .selectFrom('commission_rule_reserves')
    .select(['platform', 'reserve_bp'])
    .where('app_id', '=', appId)
    .where('rule_version_id', '=', ruleVersionId)
    .orderBy('platform')
    .execute();
  return {
    // Text columns hold contract codes (CHECK constraints); the domain checks them again.
    rules: rules.map((r) => ({
      platform: r.platform as RuleRow['platform'],
      level: r.level as RuleRow['level'],
      order_type: r.order_type as RuleRow['order_type'],
      r_own_bp: r.r_own_bp,
      r_direct_bp: r.r_direct_bp,
      r_indirect_bp: r.r_indirect_bp,
    })),
    reserves: reserves.map((r) => ({
      platform: r.platform as RuleReserve['platform'],
      reserve_bp: r.reserve_bp,
    })),
  };
}

/** A version row plus its content in the shape planSnapshot reads. */
export function asRuleVersion(
  row: VersionRow,
  content: VersionContent,
  fallbackEffective: Date,
): RuleVersion {
  return {
    rule_version_id: row.rule_version_id,
    effective_from: row.effective_from ?? fallbackEffective,
    indirect_enabled: row.indirect_enabled,
    rules: content.rules,
    reserves: content.reserves,
  };
}

export interface DraftWrite {
  readonly ruleVersionId: string;
  readonly appId: string;
  readonly status: string;
  readonly effectiveFrom: Date;
  readonly indirectEnabled: boolean;
  readonly baseVersionId: string | null;
  readonly drafterId: string;
  readonly rules: readonly RuleVersionRow[];
  readonly reserves: readonly RuleVersionReserve[];
  readonly createdAt: Date;
}

/** Inserts the version head and all its rows (append only; a changed draft is a new draft). */
export async function insertDraft(trx: Transaction<DB>, w: DraftWrite): Promise<VersionRow> {
  const app = trx.withSchema('app');
  const version = await app
    .insertInto('commission_rule_versions')
    .values({
      rule_version_id: w.ruleVersionId,
      app_id: w.appId,
      status: w.status,
      effective_from: w.effectiveFrom,
      indirect_enabled: w.indirectEnabled,
      base_version_id: w.baseVersionId,
      drafter_id: w.drafterId,
      created_at: w.createdAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (w.rules.length > 0) {
    await app
      .insertInto('commission_rules')
      .values(
        w.rules.map((r) => ({
          rule_version_id: w.ruleVersionId,
          app_id: w.appId,
          platform: r.platform,
          level: r.level,
          order_type: r.order_type,
          // Range-checked (0–8000) by the caller before the insert: Number() is exact here.
          r_own_bp: Number(r.r_own_bp),
          r_direct_bp: Number(r.r_direct_bp),
          r_indirect_bp: Number(r.r_indirect_bp),
          created_at: w.createdAt,
        })),
      )
      .execute();
  }
  if (w.reserves.length > 0) {
    await app
      .insertInto('commission_rule_reserves')
      .values(
        w.reserves.map((r) => ({
          rule_version_id: w.ruleVersionId,
          app_id: w.appId,
          platform: r.platform,
          // Range-checked (0–10000) by the caller before the insert.
          reserve_bp: Number(r.reserve_bp),
          created_at: w.createdAt,
        })),
      )
      .execute();
  }
  return version;
}

/** Snapshots of the app with paid_at ∈ [from, to), with the order platform; by order_id. */
export async function readSampleSplits(
  trx: Transaction<DB>,
  appId: string,
  from: Date,
  to: Date,
): Promise<SplitRow[]> {
  return trx
    .withSchema('app')
    .selectFrom('commission_splits as s')
    .innerJoin('order_keys as k', (join) =>
      join.onRef('k.app_id', '=', 's.app_id').onRef('k.order_id', '=', 's.order_id'),
    )
    .selectAll('s')
    .select('k.platform')
    .where('s.app_id', '=', appId)
    .where('s.paid_at', '>=', from)
    .where('s.paid_at', '<', to)
    .orderBy('s.order_id')
    .execute();
}

/** Every amount version of the sample orders (same window), for the sample digest. */
export async function readSampleAmounts(
  trx: Transaction<DB>,
  appId: string,
  from: Date,
  to: Date,
): Promise<AmountRow[]> {
  const app = trx.withSchema('app');
  return app
    .selectFrom('commission_split_amounts')
    .selectAll()
    .where('app_id', '=', appId)
    .where('order_id', 'in', (qb) =>
      qb
        .selectFrom('commission_splits')
        .select('order_id')
        .where('app_id', '=', appId)
        .where('paid_at', '>=', from)
        .where('paid_at', '<', to),
    )
    .orderBy('order_id')
    .orderBy('commission_version')
    .orderBy('role')
    .orderBy('user_id')
    .execute();
}

export interface TrialWrite {
  readonly trialId: string;
  readonly appId: string;
  readonly ruleVersionId: string;
  readonly baseVersionId: string | null;
  readonly sampleFrom: Date;
  readonly sampleTo: Date;
  readonly sampleCount: number;
  readonly sampleHash: string;
  readonly report: unknown;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export async function insertTrial(trx: Transaction<DB>, w: TrialWrite): Promise<TrialRow> {
  return trx
    .withSchema('app')
    .insertInto('commission_rule_trials')
    .values({
      trial_id: w.trialId,
      app_id: w.appId,
      rule_version_id: w.ruleVersionId,
      base_version_id: w.baseVersionId,
      sample_from: w.sampleFrom,
      sample_to: w.sampleTo,
      sample_count: w.sampleCount,
      sample_hash: w.sampleHash,
      // pg would send a JS object as text anyway; jsonb gets its JSON text explicitly.
      report: JSON.stringify(w.report),
      created_by: w.createdBy,
      created_at: w.createdAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function findTrial(
  trx: Transaction<DB>,
  appId: string,
  trialId: string,
): Promise<TrialRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('commission_rule_trials')
    .selectAll()
    .where('app_id', '=', appId)
    .where('trial_id', '=', trialId)
    .executeTakeFirst();
}

/** PUBLISH: only status, publisher_id, published_at; guarded by the status read under lock. */
export async function markPublished(
  trx: Transaction<DB>,
  w: {
    readonly appId: string;
    readonly ruleVersionId: string;
    readonly fromStatus: string;
    readonly status: string;
    readonly publisherId: string;
    readonly publishedAt: Date;
  },
): Promise<VersionRow | undefined> {
  return trx
    .withSchema('app')
    .updateTable('commission_rule_versions')
    .set({ status: w.status, publisher_id: w.publisherId, published_at: w.publishedAt })
    .where('app_id', '=', w.appId)
    .where('rule_version_id', '=', w.ruleVersionId)
    .where('status', '=', w.fromStatus)
    .returningAll()
    .executeTakeFirst();
}

/** REVOKE: only status and revoked_at; content and publisher stay as they are. */
export async function markRevoked(
  trx: Transaction<DB>,
  w: {
    readonly appId: string;
    readonly ruleVersionId: string;
    readonly fromStatus: string;
    readonly status: string;
    readonly revokedAt: Date;
  },
): Promise<VersionRow | undefined> {
  return trx
    .withSchema('app')
    .updateTable('commission_rule_versions')
    .set({ status: w.status, revoked_at: w.revokedAt })
    .where('app_id', '=', w.appId)
    .where('rule_version_id', '=', w.ruleVersionId)
    .where('status', '=', w.fromStatus)
    .returningAll()
    .executeTakeFirst();
}
