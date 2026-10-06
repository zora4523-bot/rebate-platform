// 规划/08 BR-AI-14 细则「无模型降级」的结果判定（AI-05；BR-AI-16 预算用完同此）：
// 出卡后文本用 agent.degraded，无结果出 notice agent.degraded.empty，不返回错误码，
// done.finish_reason=fallback（预算触发时为 budget）；关键词搜索在全部平台都失败时才返回 50302
// （data.fallback 带 q）。计划对象与按平台结果都手写，不经 planKeywordSearch，期望值一律手写字面量。
import { expect, it } from 'vitest';
import {
  degradeFinishReason,
  resolveDegradedOutcome,
  type KeywordSearchPlan,
  type PlatformSearchResult,
} from '../../../../apps/api/src/modules/agent/model-gateway/degraded/index.ts';

const PLAN: KeywordSearchPlan = {
  q: '蓝牙耳机 降噪',
  platforms: ['taobao', 'jd', 'pdd'],
  sort: 'relevance',
};

it.each([
  ['models_failed', 'fallback'],
  ['model_timeout', 'fallback'],
  ['route_no_model', 'fallback'],
  ['route_unavailable', 'fallback'],
  ['vendor_misconfigured', 'fallback'],
  ['budget', 'budget'],
] as const)('[BR-AI-14][BR-AI-16] 降级原因 %s → done.finish_reason=%s', (reason, finish) => {
  expect(degradeFinishReason(reason)).toBe(finish);
});

// 每个降级原因与它应得的 done.finish_reason，手写字面量；下面每个分支都对全部 6 个原因各跑一遍，
// 防止实现按原因把某一类（如 route_no_model）一律判成空结果或 50302。
const REASON_ROWS = [
  ['models_failed', 'fallback'],
  ['model_timeout', 'fallback'],
  ['budget', 'budget'],
  ['route_no_model', 'fallback'],
  ['route_unavailable', 'fallback'],
  ['vendor_misconfigured', 'fallback'],
] as const;

it.each(REASON_ROWS)(
  '[BR-AI-14][BR-AI-16] 任一平台成功且有结果就出卡（原因 %s → %s）：文本键 agent.degraded，条目按平台顺序、平台内原顺序透传，失败平台跳过',
  (reason, finishReason) => {
    const mixed: PlatformSearchResult[] = [
      { platform: 'taobao', ok: true, items: [{ id: 'tb-1' }, { id: 'tb-2' }] },
      { platform: 'jd', ok: false },
      { platform: 'pdd', ok: true, items: [{ id: 'pdd-1' }] },
    ];
    expect(resolveDegradedOutcome(reason, PLAN, mixed)).toStrictEqual({
      kind: 'cards',
      textKey: 'agent.degraded',
      finishReason,
      items: [{ id: 'tb-1' }, { id: 'tb-2' }, { id: 'pdd-1' }],
    });
  },
);

it.each(REASON_ROWS)(
  '[BR-AI-14][BR-AI-16] 只有京东成功且有 1 条、其余平台失败：仍出卡，不返回错误码（原因 %s → %s）',
  (reason, finishReason) => {
    const onlyJd: PlatformSearchResult[] = [
      { platform: 'taobao', ok: false },
      { platform: 'jd', ok: true, items: [{ id: 'jd-1' }] },
      { platform: 'pdd', ok: false },
    ];
    expect(resolveDegradedOutcome(reason, PLAN, onlyJd)).toStrictEqual({
      kind: 'cards',
      textKey: 'agent.degraded',
      finishReason,
      items: [{ id: 'jd-1' }],
    });
  },
);

it.each(REASON_ROWS)(
  '[BR-AI-14][BR-AI-16] 只有最后一个平台有 3 条结果、前面的平台成功但为空：仍出卡，条目只有这 3 条且顺序不变（原因 %s → %s）',
  (reason, finishReason) => {
    const lastOnly: PlatformSearchResult[] = [
      { platform: 'taobao', ok: true, items: [] },
      { platform: 'jd', ok: true, items: [] },
      { platform: 'pdd', ok: true, items: [{ id: 'p-3' }, { id: 'p-1' }, { id: 'p-2' }] },
    ];
    expect(resolveDegradedOutcome(reason, PLAN, lastOnly)).toStrictEqual({
      kind: 'cards',
      textKey: 'agent.degraded',
      finishReason,
      items: [{ id: 'p-3' }, { id: 'p-1' }, { id: 'p-2' }],
    });
  },
);

it.each(REASON_ROWS)(
  '[BR-AI-14][BR-AI-16] 所有平台都成功但都没有结果：出 notice agent.degraded.empty，不返回错误码（原因 %s → %s）',
  (reason, finishReason) => {
    const allEmpty: PlatformSearchResult[] = [
      { platform: 'taobao', ok: true, items: [] },
      { platform: 'jd', ok: true, items: [] },
      { platform: 'pdd', ok: true, items: [] },
    ];
    expect(resolveDegradedOutcome(reason, PLAN, allEmpty)).toStrictEqual({
      kind: 'empty',
      noticeKey: 'agent.degraded.empty',
      finishReason,
    });
  },
);

it.each(REASON_ROWS)(
  '[BR-AI-14][BR-AI-16] 部分平台失败、其余成功但为空：不是「全部平台都失败」，出空结果 notice 而不是 50302（原因 %s → %s）',
  (reason, finishReason) => {
    const failedOrEmpty: PlatformSearchResult[] = [
      { platform: 'taobao', ok: false },
      { platform: 'jd', ok: true, items: [] },
      { platform: 'pdd', ok: false },
    ];
    expect(resolveDegradedOutcome(reason, PLAN, failedOrEmpty)).toStrictEqual({
      kind: 'empty',
      noticeKey: 'agent.degraded.empty',
      finishReason,
    });
  },
);

it.each(REASON_ROWS)(
  '[BR-AI-14] 关键词搜索在全部平台都失败时才返回 50302，data.fallback 带计划里的 q，不带 finish_reason（原因 %s）',
  (reason) => {
    const allFailed: PlatformSearchResult[] = [
      { platform: 'taobao', ok: false },
      { platform: 'jd', ok: false },
      { platform: 'pdd', ok: false },
    ];
    expect(resolveDegradedOutcome(reason, PLAN, allFailed)).toStrictEqual({
      kind: 'error',
      code: 50302,
      fallback: { q: '蓝牙耳机 降噪' },
    });
  },
);

it.each(REASON_ROWS)('[BR-AI-14] 只开启 1 个平台且它失败：50302 带 q（原因 %s）', (reason) => {
  const plan: KeywordSearchPlan = { q: 'a', platforms: ['jd'], sort: 'relevance' };
  expect(resolveDegradedOutcome(reason, plan, [{ platform: 'jd', ok: false }])).toStrictEqual({
    kind: 'error',
    code: 50302,
    fallback: { q: 'a' },
  });
});

it.each(REASON_ROWS)(
  '[BR-AI-14] 已开启平台为空（没有任何平台可搜）：没有平台搜索失败，出空结果 notice 而不是 50302（原因 %s → %s）',
  (reason, finishReason) => {
    // 编排者 2026-10-06 按代码评审改定（BR-AI-14「全部平台都失败时才返回 50302」：没有搜索就没有失败）。
    const plan: KeywordSearchPlan = { q: '洗衣液', platforms: [], sort: 'relevance' };
    expect(resolveDegradedOutcome(reason, plan, [])).toStrictEqual({
      kind: 'empty',
      noticeKey: 'agent.degraded.empty',
      finishReason,
    });
  },
);

it.each(REASON_ROWS)(
  '[BR-AI-14][BR-AI-16] 没有可取的关键词（计划为 null）：不搜索、不返回错误码，出空结果 notice（原因 %s → %s）',
  (reason, finishReason) => {
    expect(resolveDegradedOutcome(reason, null, [])).toStrictEqual({
      kind: 'empty',
      noticeKey: 'agent.degraded.empty',
      finishReason,
    });
  },
);
