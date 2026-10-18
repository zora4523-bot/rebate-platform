import type { DB } from '@couli/db';
import type {
  RuleVersionReserve,
  RuleVersionRow,
  RuleVersionValidationCode,
  ValidateRuleVersionResult,
} from '@couli/domain';
import type { Selectable, Transaction } from 'kysely';
import type { AuditPort, Clock } from '../../platform/index.ts';

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

  constructor(code: RulePublicationErrorCode) {
    super('NotImplemented: RulePublicationError');
    void code;
    throw new Error('NotImplemented: RulePublicationError');
  }
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
  void tx;
  void input;
  void deps;
  throw new Error('NotImplemented: createDraft');
}

/** 原样返回 validateRuleVersion 结果；不写库、不写成功审计。 */
export async function validateDraft(
  tx: Transaction<DB>,
  input: ValidateRuleDraftInput,
  deps: RulePublicationDependencies,
): Promise<ValidateRuleVersionResult> {
  void tx;
  void input;
  void deps;
  throw new Error('NotImplemented: validateDraft');
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
  void tx;
  void input;
  void deps;
  throw new Error('NotImplemented: runTrial');
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
  void tx;
  void input;
  void deps;
  throw new Error('NotImplemented: publish');
}

/** 锁版本行后按秒比较 Clock；经 REVOKE；action=commission.rule.revoke。 */
export async function revoke(
  tx: Transaction<DB>,
  input: RevokeRuleInput,
  deps: RulePublicationDependencies,
): Promise<PublishedRuleVersion> {
  void tx;
  void input;
  void deps;
  throw new Error('NotImplemented: revoke');
}
