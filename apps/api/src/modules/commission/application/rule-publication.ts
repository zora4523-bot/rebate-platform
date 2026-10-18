// B2-03k: commission rule publication service (BR-CALC-05/06/07/11/22). Draft (append only: a
// changed draft is a new draft), validate (validateRuleVersion as is), trial difference report
// (stored in commission_rule_trials), publish and revoke (state only through the generated
// transitionCommissionRuleVersion, the app's version rows locked FOR UPDATE in the same
// transaction). Every use case runs in the caller's transaction; the router (B2-03l) checks the
// permission and step-up and passes the verified actor.
//
// Order of a write use case: all checks → database writes → audit append. The audit port does not
// take the caller's transaction, so it is called only after the writes succeeded; when it fails,
// the error reaches the caller, whose transaction then rolls back every write of the use case
// (the audit row, if the port wrote one elsewhere, describes an action that did not commit).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import {
  transitionCommissionRuleVersion,
  validateRuleVersion,
  type CommissionRuleVersionState,
  type RuleVersionReserve,
  type RuleVersionRow,
  type RuleVersionValidationCode,
  type ValidateRuleVersionInput,
  type ValidateRuleVersionResult,
} from '@couli/domain';
import type { Selectable, Transaction } from 'kysely';
import type { AuditPort, Clock } from '../../platform/index.ts';
import {
  TrialComputationError,
  buildTrialReport,
  isValidInstant,
  peopleOfSnapshot,
  sampleDigest,
  shiftMs,
  toChinaIso,
  wholeSeconds,
  type TrialSample,
} from '../domain/rule-trial.ts';
import {
  asRuleVersion,
  findTrial,
  findVersion,
  insertDraft,
  insertTrial,
  lockAppVersions,
  markPublished,
  markRevoked,
  readAppVersions,
  readSampleAmounts,
  readSampleSplits,
  readVersionContent,
  type AmountRow,
  type SplitRow,
  type VersionContent,
  type VersionRow,
} from '../infra/rule-publication-store.ts';
import type { RuleVersion } from '../domain/rules.ts';

/** 路由已核验权限与 step-up；本服务不接受客户端指定的身份。 */
export interface RulePublicationActor {
  readonly adminUserId: string;
}

export interface RulePublicationDependencies {
  readonly clock: Clock;
  readonly platforms: readonly string[];
  readonly audit: AuditPort;
}

export interface RulePublicationContext {
  readonly appId: string;
  readonly actor: RulePublicationActor;
}

export interface CreateRuleDraftInput extends RulePublicationContext {
  /** ISO 8601 +08:00 解析后的时刻；建草稿时写定，比较精度到秒。 */
  readonly effectiveFrom: Date;
  readonly baseVersionId: string | null;
  readonly indirectEnabled: boolean;
  readonly rules: readonly RuleVersionRow[];
  readonly reserves: readonly RuleVersionReserve[];
}

export interface RuleDraftInput extends RulePublicationContext {
  readonly draftId: string;
}

export type ValidateRuleDraftInput = RuleDraftInput;

export interface PublishRuleInput extends RuleDraftInput {
  readonly trialId: string;
}

export interface RevokeRuleInput extends RulePublicationContext {
  readonly versionId: string;
}

/** JSON 金额为安全整数分；溢出拒绝生成报告，不能丢精度。 */
export interface RuleTrialTotals {
  readonly reserveBp: number;
  readonly reserveFen: number;
  readonly ownFen: number;
  readonly directFen: number;
  readonly indirectFen: number;
  readonly platformRetainFen: number;
}

export interface RuleTrialPlatform {
  readonly platform: string;
  /** 首版无基准时为 null；空样本仍列出配置的各平台。 */
  readonly current: RuleTrialTotals | null;
  readonly draft: RuleTrialTotals;
}

export interface RuleTrialReport {
  readonly platforms: readonly RuleTrialPlatform[];
}

export interface RuleTrialResult {
  readonly trialId: string;
  readonly sampleFrom: Date;
  readonly sampleTo: Date;
  readonly sampleCount: number;
  readonly sampleHash: string;
  readonly report: RuleTrialReport;
}

export type PublishedRuleVersion = Selectable<DB['commission_rule_versions']>;

/** 模块内部诊断，后续后台契约任务再映射 HTTP 错误码。 */
export type RulePublicationErrorCode =
  | RuleVersionValidationCode
  | 'VERSION_NOT_FOUND'
  | 'BASE_VERSION_MISMATCH'
  | 'TRIAL_NOT_FOUND'
  | 'TRIAL_DRAFT_MISMATCH'
  | 'TRIAL_EXPIRED'
  | 'TRIAL_SAMPLE_CHANGED'
  | 'ILLEGAL_TRANSITION'
  | 'VERSION_ALREADY_EFFECTIVE'
  | 'TRIAL_FAILED';

export class RulePublicationError extends Error {
  declare readonly code: RulePublicationErrorCode;

  constructor(code: RulePublicationErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'RulePublicationError';
    this.code = code;
  }
}

/** BR-CALC-22: the trial sample is the 7 days before the request, [now - 7 d, now). */
const TRIAL_WINDOW_MS = 7 * 86_400_000;
/** 编排 P3=A: a trial older than 10 minutes (or from the future) cannot back a publish. */
const TRIAL_MAX_AGE_MS = 600_000;

/**
 * Codes that make a draft unstorable (the DB CHECKs / keys would reject it, or the instant is not
 * a time): refused at draft time. Completeness, totals, the indirect switch and the effective
 * time relative to other versions are publication checks (validateDraft / runTrial / publish).
 */
const UNSTORABLE: ReadonlySet<RuleVersionValidationCode> = new Set<RuleVersionValidationCode>([
  'UNKNOWN_PLATFORM',
  'DUPLICATE_RULE',
  'DUPLICATE_RESERVE',
  'RATIO_OUT_OF_RANGE',
  'RESERVE_OUT_OF_RANGE',
  'INVALID_EFFECTIVE_FROM',
]);

function stateOf(status: string): CommissionRuleVersionState {
  if (status === 'draft' || status === 'published' || status === 'revoked') return status;
  throw new RulePublicationError('ILLEGAL_TRANSITION', `unknown version status ${status}`);
}

/** Only published, unrevoked versions block / form the base (BR-CALC-11, BR-CALC-22). */
function isLive(row: VersionRow): boolean {
  return row.status === 'published' && row.revoked_at === null;
}

function effectiveOf(row: VersionRow): Date {
  if (!isValidInstant(row.effective_from)) {
    throw new Error(`commission: rule version ${row.rule_version_id} has no effective_from`);
  }
  return row.effective_from;
}

/** The latest published, unrevoked version (greatest effective_from), or null. */
function latestLive(rows: readonly VersionRow[]): VersionRow | null {
  let latest: VersionRow | null = null;
  for (const row of rows) {
    if (!isLive(row)) continue;
    if (latest === null || effectiveOf(row).getTime() > effectiveOf(latest).getTime()) {
      latest = row;
    }
  }
  return latest;
}

function liveEffectiveFroms(rows: readonly VersionRow[]): string[] {
  return rows.filter(isLive).map((row) => toChinaIso(effectiveOf(row)));
}

/** validateRuleVersion input from a stored draft (bigint ratios, ISO +08:00 instants). */
function validationInput(
  row: VersionRow,
  content: VersionContent,
  platforms: readonly string[],
  publishAt: Date,
  versions: readonly VersionRow[],
): ValidateRuleVersionInput {
  return {
    draft: {
      indirect_enabled: row.indirect_enabled,
      // A draft without effective_from fails validation as INVALID_EFFECTIVE_FROM.
      effective_from: isValidInstant(row.effective_from) ? toChinaIso(row.effective_from) : '',
      rules: content.rules.map((r): RuleVersionRow => ({
        platform: r.platform,
        level: r.level,
        order_type: r.order_type,
        r_own_bp: BigInt(r.r_own_bp),
        r_direct_bp: BigInt(r.r_direct_bp),
        r_indirect_bp: BigInt(r.r_indirect_bp),
      })),
      reserves: content.reserves.map((r): RuleVersionReserve => ({
        platform: r.platform,
        reserve_bp: BigInt(r.reserve_bp),
      })),
    },
    platforms,
    publish_at: toChinaIso(publishAt),
    published_effective_froms: liveEffectiveFroms(
      versions.filter((v) => v.rule_version_id !== row.rule_version_id),
    ),
  };
}

function rejectInvalid(result: ValidateRuleVersionResult): void {
  if (result.ok) return;
  const first = result.errors[0];
  if (first === undefined) throw new Error('commission: validation failed without errors');
  throw new RulePublicationError(first.code, first.detail);
}

/** Audit snapshot of a version head (JSON values only). */
function versionJson(row: VersionRow): { [key: string]: string | boolean | null } {
  const at = (value: Date | null) => (value === null ? null : toChinaIso(value));
  return {
    rule_version_id: row.rule_version_id,
    status: row.status,
    effective_from: at(row.effective_from),
    indirect_enabled: row.indirect_enabled,
    base_version_id: row.base_version_id,
    drafter_id: row.drafter_id,
    publisher_id: row.publisher_id,
    published_at: at(row.published_at),
    revoked_at: at(row.revoked_at),
    created_at: at(row.created_at),
  };
}

async function readDraftVersion(
  tx: Transaction<DB>,
  appId: string,
  draftId: string,
): Promise<VersionRow> {
  const row = await findVersion(tx, appId, draftId);
  if (row === undefined) throw new RulePublicationError('VERSION_NOT_FOUND');
  return row;
}

/** PUBLISH must be legal from the stored state (trial and validation only make sense then). */
function publishStep(row: VersionRow) {
  const step = transitionCommissionRuleVersion(stateOf(row.status), 'PUBLISH');
  if (!step.ok) throw new RulePublicationError('ILLEGAL_TRANSITION', `from ${row.status}`);
  return step;
}

interface SampleRows {
  readonly from: Date;
  readonly to: Date;
  readonly splits: readonly SplitRow[];
  readonly amounts: readonly AmountRow[];
}

/** The snapshots of [from, to) and every amount version of those orders (database only). */
async function readSampleRows(
  tx: Transaction<DB>,
  appId: string,
  from: Date,
  to: Date,
): Promise<SampleRows> {
  const splits = await readSampleSplits(tx, appId, from, to);
  const amounts = await readSampleAmounts(tx, appId, from, to);
  return { from, to, splits, amounts };
}

/** Deterministic digest of the sample rows (pure). */
function digestOf(rows: SampleRows): string {
  return sampleDigest({
    fromMs: rows.from.getTime(),
    toMs: rows.to.getTime(),
    splits: rows.splits.map((s) => ({
      orderId: s.order_id,
      platform: s.platform,
      ruleVersionId: s.rule_version_id,
      orderType: s.order_type,
      activityType: s.activity_type,
      rebateMode: s.rebate_mode,
      paidAtMs: s.paid_at.getTime(),
      paidAtSource: s.paid_at_source,
      rawNFen: s.raw_n_fen,
      subsidyCommissionFen: s.subsidy_commission_fen,
      reserveBp: s.reserve_bp,
      reserveFen: s.reserve_fen,
      tljDeductFen: s.tlj_deduct_fen,
      baseFen: s.base_fen,
      platformRetainFen: s.platform_retain_fen,
      beneficiaries: s.beneficiaries,
    })),
    amounts: rows.amounts.map((a) => ({
      orderId: a.order_id,
      commissionVersion: a.commission_version,
      userId: a.user_id,
      role: a.role,
      baseFen: a.base_fen,
      amountFen: a.amount_fen,
    })),
  });
}

/** What the trial recomputes from, per stored snapshot (pure; bad data throws). */
function samplesOf(splits: readonly SplitRow[]): TrialSample[] {
  return splits.map((s): TrialSample => {
    if (s.order_type !== 'self' && s.order_type !== 'share') {
      throw new TrialComputationError(`snapshot ${s.order_id} has order_type ${s.order_type}`);
    }
    const mode = s.rebate_mode;
    if (mode !== null && mode !== 'none' && mode !== 'normal') {
      throw new TrialComputationError(`snapshot ${s.order_id} has rebate_mode ${mode}`);
    }
    return {
      orderId: s.order_id,
      platform: s.platform,
      orderType: s.order_type,
      rebateMode: mode,
      rawNFen: s.raw_n_fen,
      subsidyCommissionFen: s.subsidy_commission_fen,
      tljDeductFen: s.tlj_deduct_fen,
      ...peopleOfSnapshot(s.beneficiaries),
    };
  });
}

/**
 * 所有用例接受调用方事务；调用方须在成功时提交、异常时回滚。
 * 起草只追加，经 DRAFT_CREATED；审计 action=commission.rule.draft。
 * effectiveFrom 与比例等内容一并写定；改生效时间也须新建草稿。
 */
export async function createDraft(
  tx: Transaction<DB>,
  input: CreateRuleDraftInput,
  deps: RulePublicationDependencies,
): Promise<PublishedRuleVersion> {
  const now = deps.clock.now();
  if (!isValidInstant(input.effectiveFrom)) {
    throw new RulePublicationError('INVALID_EFFECTIVE_FROM', 'effectiveFrom is not a valid Date');
  }
  if (input.baseVersionId !== null) {
    const base = await findVersion(tx, input.appId, input.baseVersionId);
    if (base === undefined) throw new RulePublicationError('VERSION_NOT_FOUND', 'base version');
    if (!isLive(base)) {
      throw new RulePublicationError('BASE_VERSION_MISMATCH', 'base is not a published version');
    }
  }
  let effectiveIso: string;
  try {
    effectiveIso = toChinaIso(input.effectiveFrom);
  } catch {
    throw new RulePublicationError('INVALID_EFFECTIVE_FROM', 'effectiveFrom is out of range');
  }
  const checked = validateRuleVersion({
    draft: {
      indirect_enabled: input.indirectEnabled,
      effective_from: effectiveIso,
      rules: input.rules,
      reserves: input.reserves,
    },
    platforms: deps.platforms,
    publish_at: toChinaIso(now),
    published_effective_froms: [],
  });
  if (!checked.ok) {
    const unstorable = checked.errors.find((e) => UNSTORABLE.has(e.code));
    if (unstorable !== undefined) {
      throw new RulePublicationError(unstorable.code, unstorable.detail);
    }
  }
  const step = transitionCommissionRuleVersion(null, 'DRAFT_CREATED');
  if (!step.ok) throw new RulePublicationError('ILLEGAL_TRANSITION', 'DRAFT_CREATED');

  const row = await insertDraft(tx, {
    ruleVersionId: randomUUID(),
    appId: input.appId,
    status: step.to,
    effectiveFrom: input.effectiveFrom,
    indirectEnabled: input.indirectEnabled,
    baseVersionId: input.baseVersionId,
    drafterId: input.actor.adminUserId,
    rules: input.rules,
    reserves: input.reserves,
    createdAt: now,
  });
  await deps.audit.append({
    appId: input.appId,
    actor: input.actor.adminUserId,
    action: 'commission.rule.draft',
    target: row.rule_version_id,
    before: null,
    after: {
      ...versionJson(row),
      rules: input.rules.map((r) => ({
        platform: r.platform,
        level: r.level,
        order_type: r.order_type,
        r_own_bp: Number(r.r_own_bp),
        r_direct_bp: Number(r.r_direct_bp),
        r_indirect_bp: Number(r.r_indirect_bp),
      })),
      reserves: input.reserves.map((r) => ({
        platform: r.platform,
        reserve_bp: Number(r.reserve_bp),
      })),
    },
    ip: null,
  });
  return row;
}

/** 原样返回 validateRuleVersion 结果；不写库、不写成功审计。 */
export async function validateDraft(
  tx: Transaction<DB>,
  input: ValidateRuleDraftInput,
  deps: RulePublicationDependencies,
): Promise<ValidateRuleVersionResult> {
  const now = deps.clock.now();
  const row = await readDraftVersion(tx, input.appId, input.draftId);
  publishStep(row);
  const versions = await readAppVersions(tx, input.appId);
  const content = await readVersionContent(tx, input.appId, row.rule_version_id);
  return validateRuleVersion(validationInput(row, content, deps.platforms, now, versions));
}

/**
 * 样本来自本 app 的 commission_splits（平台经 order_keys），金额版本也纳入摘要。
 * 固定并保存 [Clock - 7 天, Clock) 窗口；发布重验同一窗口，不能滚动窗口。
 * 审计 action=commission.rule.trial；失败不能留下报告。
 */
export async function runTrial(
  tx: Transaction<DB>,
  input: RuleDraftInput,
  deps: RulePublicationDependencies,
): Promise<RuleTrialResult> {
  const now = deps.clock.now();
  const row = await readDraftVersion(tx, input.appId, input.draftId);
  publishStep(row);
  const versions = await readAppVersions(tx, input.appId);
  const content = await readVersionContent(tx, input.appId, row.rule_version_id);
  // BR-CALC-22: a draft that fails validation gets no trial report.
  rejectInvalid(validateRuleVersion(validationInput(row, content, deps.platforms, now, versions)));

  let current: RuleVersion | null = null;
  if (row.base_version_id !== null) {
    const base = versions.find((v) => v.rule_version_id === row.base_version_id);
    if (base === undefined) throw new RulePublicationError('VERSION_NOT_FOUND', 'base version');
    const baseContent = await readVersionContent(tx, input.appId, base.rule_version_id);
    current = asRuleVersion(base, baseContent, now);
  }
  const draft = asRuleVersion(row, content, now);
  const sampleFrom = shiftMs(now, -TRIAL_WINDOW_MS);
  const sampleTo = now;

  const rows = await readSampleRows(tx, input.appId, sampleFrom, sampleTo);
  let sampleHash: string;
  let report: RuleTrialReport;
  try {
    // Pure recomputation only: any failure here (bad snapshot data, missing row or reserve,
    // amount beyond the safe JSON range) is TRIAL_FAILED and leaves no report.
    sampleHash = digestOf(rows);
    report = {
      platforms: buildTrialReport({
        platforms: deps.platforms,
        current,
        draft,
        samples: samplesOf(rows.splits),
      }),
    };
  } catch (error) {
    throw new RulePublicationError(
      'TRIAL_FAILED',
      error instanceof Error ? error.message : 'trial recomputation failed',
    );
  }

  const trial = await insertTrial(tx, {
    trialId: randomUUID(),
    appId: input.appId,
    ruleVersionId: row.rule_version_id,
    baseVersionId: row.base_version_id,
    sampleFrom,
    sampleTo,
    sampleCount: rows.splits.length,
    sampleHash,
    report,
    createdBy: input.actor.adminUserId,
    createdAt: now,
  });
  await deps.audit.append({
    appId: input.appId,
    actor: input.actor.adminUserId,
    action: 'commission.rule.trial',
    target: trial.trial_id,
    before: null,
    after: {
      rule_version_id: trial.rule_version_id,
      base_version_id: trial.base_version_id,
      sample_from: toChinaIso(trial.sample_from),
      sample_to: toChinaIso(trial.sample_to),
      sample_count: trial.sample_count,
      sample_hash: trial.sample_hash,
      report: trial.report,
    },
    ip: null,
  });
  return {
    trialId: trial.trial_id,
    sampleFrom: trial.sample_from,
    sampleTo: trial.sample_to,
    sampleCount: trial.sample_count,
    sampleHash: trial.sample_hash,
    report,
  };
}

/**
 * 同事务 FOR UPDATE 锁本 app 版本行，再重验状态、基准、规则、试算和生效时刻。
 * 生效时刻只读草稿 effective_from；仅更新 status、publisher_id、published_at。
 * 试算年龄 <= 10 分钟且不得来自未来；经 PUBLISH；action=commission.rule.publish。
 */
export async function publish(
  tx: Transaction<DB>,
  input: PublishRuleInput,
  deps: RulePublicationDependencies,
): Promise<PublishedRuleVersion> {
  const now = deps.clock.now();
  await lockAppVersions(tx, input.appId);
  const versions = await readAppVersions(tx, input.appId);
  const row = versions.find((v) => v.rule_version_id === input.draftId);
  if (row === undefined) throw new RulePublicationError('VERSION_NOT_FOUND');
  const step = publishStep(row);

  // BR-CALC-22: the latest published version must still be the draft's base (null = first).
  const latest = latestLive(versions);
  if ((latest?.rule_version_id ?? null) !== row.base_version_id) {
    throw new RulePublicationError('BASE_VERSION_MISMATCH');
  }

  const trial = await findTrial(tx, input.appId, input.trialId);
  if (trial === undefined) throw new RulePublicationError('TRIAL_NOT_FOUND');
  if (
    trial.rule_version_id !== row.rule_version_id ||
    trial.base_version_id !== row.base_version_id
  ) {
    throw new RulePublicationError('TRIAL_DRAFT_MISMATCH');
  }
  const age = now.getTime() - trial.created_at.getTime();
  if (age < 0 || age > TRIAL_MAX_AGE_MS) throw new RulePublicationError('TRIAL_EXPIRED');

  const content = await readVersionContent(tx, input.appId, row.rule_version_id);
  rejectInvalid(validateRuleVersion(validationInput(row, content, deps.platforms, now, versions)));

  // The trial's own window again (not a rolling one): any new or changed snapshot → re-run.
  const rows = await readSampleRows(tx, input.appId, trial.sample_from, trial.sample_to);
  if (rows.splits.length !== trial.sample_count || digestOf(rows) !== trial.sample_hash) {
    throw new RulePublicationError('TRIAL_SAMPLE_CHANGED');
  }

  const published = await markPublished(tx, {
    appId: input.appId,
    ruleVersionId: row.rule_version_id,
    fromStatus: row.status,
    status: step.to,
    publisherId: input.actor.adminUserId,
    publishedAt: now,
  });
  if (published === undefined) throw new RulePublicationError('ILLEGAL_TRANSITION');
  await deps.audit.append({
    appId: input.appId,
    actor: input.actor.adminUserId,
    action: 'commission.rule.publish',
    target: published.rule_version_id,
    before: versionJson(row),
    after: { ...versionJson(published), trial_id: trial.trial_id },
    ip: null,
  });
  return published;
}

/** 锁版本行后按秒比较 Clock；经 REVOKE；action=commission.rule.revoke。 */
export async function revoke(
  tx: Transaction<DB>,
  input: RevokeRuleInput,
  deps: RulePublicationDependencies,
): Promise<PublishedRuleVersion> {
  const now = deps.clock.now();
  await lockAppVersions(tx, input.appId);
  const versions = await readAppVersions(tx, input.appId);
  const row = versions.find((v) => v.rule_version_id === input.versionId);
  if (row === undefined) throw new RulePublicationError('VERSION_NOT_FOUND');
  const step = transitionCommissionRuleVersion(stateOf(row.status), 'REVOKE');
  if (!step.ok) throw new RulePublicationError('ILLEGAL_TRANSITION', `from ${row.status}`);
  // BR-CALC-11: only while now < effective_from, compared in whole seconds.
  if (wholeSeconds(now) >= wholeSeconds(effectiveOf(row))) {
    throw new RulePublicationError('VERSION_ALREADY_EFFECTIVE');
  }

  const revoked = await markRevoked(tx, {
    appId: input.appId,
    ruleVersionId: row.rule_version_id,
    fromStatus: row.status,
    status: step.to,
    revokedAt: now,
  });
  if (revoked === undefined) throw new RulePublicationError('ILLEGAL_TRANSITION');
  await deps.audit.append({
    appId: input.appId,
    actor: input.actor.adminUserId,
    action: 'commission.rule.revoke',
    target: revoked.rule_version_id,
    before: versionJson(row),
    after: versionJson(revoked),
    ip: null,
  });
  return revoked;
}
