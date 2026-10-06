// ModelGateway 第四段：无模型降级规划器（B3-02d；规划/08 BR-AI-14 细则「无模型降级」，AI-05；
// BR-AI-16 预算用完同此）。纯函数：不调模型、不调搜索、不读时钟、不做脱敏。
// 取词上限、平台、排序、文案键与 50302 的条件只在 08 维护；规则测试在 test/spec/agent/model-degraded/。
// 本段只在错误结果里给出 q；调用方按 SSE 契约映射到 error.fallback_q。

/** 只由 B3-05 Preprocessor 的脱敏函数产出（BR-AI-14 脱敏表）；普通 string 不能直接传入。 */
export type RedactedText = string & { readonly __brand: 'RedactedText' };

/** 进入无模型降级的原因（BR-AI-14 细则「触发」；BR-AI-16 预算用完为 budget）。 */
export type DegradeReason =
  | 'models_failed'
  | 'model_timeout'
  | 'budget'
  | 'route_no_model'
  | 'route_unavailable'
  | 'vendor_misconfigured';

/** done.finish_reason 的取值（contracts/enums agent_finish_reason 的子集）。 */
export type DegradeFinishReason = 'fallback' | 'budget';

/** search_products 的关键词搜索参数；只有这三个键，不抽取价格与规格条件。 */
export interface KeywordSearchPlan {
  readonly q: string;
  readonly platforms: readonly string[];
  readonly sort: 'relevance';
}

/** 取词配置：maxChars 为取词上限（Unicode 码点，正整数）；不传时用 BR-AI-14 细则的默认值。 */
export interface KeywordPlanOptions {
  readonly maxChars?: number;
}

/** 调用方（B3-04 search_products）按平台给出的搜索结果；本段只判定结果类型。 */
export type PlatformSearchResult =
  | { readonly platform: string; readonly ok: true; readonly items: readonly unknown[] }
  | { readonly platform: string; readonly ok: false };

export type DegradedOutcome =
  | {
      readonly kind: 'cards';
      readonly textKey: 'agent.degraded';
      readonly finishReason: DegradeFinishReason;
      readonly items: readonly unknown[];
    }
  | {
      readonly kind: 'empty';
      readonly noticeKey: 'agent.degraded.empty';
      readonly finishReason: DegradeFinishReason;
    }
  | { readonly kind: 'error'; readonly code: 50302; readonly fallback: { readonly q: string } };

/** 降级原因对应的 done.finish_reason：预算触发为 budget，其余为 fallback。 */
export function degradeFinishReason(reason: DegradeReason): DegradeFinishReason {
  return reason === 'budget' ? 'budget' : 'fallback';
}

/**
 * 关键词取词：去掉首尾空白与标点后按 Unicode 码点取前若干字符（上限可由 options.maxChars 配置，
 * 默认值见 BR-AI-14 细则）；
 * 去完为空返回 null。platforms 为已开启平台的副本，顺序不变；sort 固定为 relevance。
 */
export function planKeywordSearch(
  text: RedactedText,
  enabledPlatforms: readonly string[],
  options?: KeywordPlanOptions,
): KeywordSearchPlan | null {
  const maxChars = options?.maxChars ?? 30;
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new RangeError('maxChars must be a positive safe integer');
  }

  const trimmed = text.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '');
  if (trimmed === '') return null;

  return {
    q: Array.from(trimmed).slice(0, maxChars).join(''),
    platforms: [...enabledPlatforms],
    sort: 'relevance',
  };
}

/**
 * 由按平台的搜索结果判定出卡、空结果或 50302（计划内有平台且全部都失败时才 50302；
 * 已开启平台为空时出空结果）。
 * 调用方须在计划内每个平台搜索完成后传入结果；缺失结果不能当作搜索失败。
 */
export function resolveDegradedOutcome(
  reason: DegradeReason,
  plan: KeywordSearchPlan | null,
  results: readonly PlatformSearchResult[],
): DegradedOutcome {
  const finishReason = degradeFinishReason(reason);
  const empty: DegradedOutcome = {
    kind: 'empty',
    noticeKey: 'agent.degraded.empty',
    finishReason,
  };
  if (plan === null) return empty;
  // 没有开启的平台就没有搜索，也就没有平台失败：出空结果，不是 50302。
  if (plan.platforms.length === 0) return empty;

  let hasSuccess = false;
  const items: unknown[] = [];
  for (const platform of plan.platforms) {
    const result = results.find((candidate) => candidate.platform === platform);
    if (result === undefined) {
      throw new Error('Missing search result for an enabled platform');
    }
    if (result.ok) {
      hasSuccess = true;
      for (const item of result.items) items.push(item);
    }
  }

  if (items.length > 0) {
    return { kind: 'cards', textKey: 'agent.degraded', finishReason, items };
  }
  if (hasSuccess) return empty;

  // 计划非空且每个平台都明确失败。
  return { kind: 'error', code: 50302, fallback: { q: plan.q } };
}
