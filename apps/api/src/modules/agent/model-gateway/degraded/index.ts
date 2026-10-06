// ModelGateway 第四段：无模型降级规划器（B3-02d；规划/08 BR-AI-14 细则「无模型降级」，AI-05；
// BR-AI-16 预算用完同此）。纯函数：不调模型、不调搜索、不读时钟、不做脱敏。
// 取词上限、平台、排序、文案键与 50302 的条件只在 08 维护；规则测试在 test/spec/agent/model-degraded/。
// 50302 怎样把 q 随 SSE error 帧下发由契约定（couli-runs/B3-02-03/plan.md §6 K1），本段只在结果里给出 q。

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
  void reason;
  throw new Error('NotImplemented: degradeFinishReason');
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
  void text;
  void enabledPlatforms;
  void options;
  throw new Error('NotImplemented: planKeywordSearch');
}

/** 由按平台的搜索结果判定出卡、空结果或 50302（全部平台都失败时才 50302）。 */
export function resolveDegradedOutcome(
  reason: DegradeReason,
  plan: KeywordSearchPlan | null,
  results: readonly PlatformSearchResult[],
): DegradedOutcome {
  void reason;
  void plan;
  void results;
  throw new Error('NotImplemented: resolveDegradedOutcome');
}
