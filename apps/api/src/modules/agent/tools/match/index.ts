// B3-04d：逐张卡片的条件标记（BR-AI-24）。match_tag / spec_text / benefit_tags 全由代码判定，
// 模型不参与。search_products 的 handler 里没有挂钩点：本段只导出函数，由 B3-05g 的 search 装饰器
// 在下发前改写 product_list 的 items。
import { findSpecInTitle } from '@couli/domain';
import type { Scheduler } from '../../../platform/index.ts';
import type { AgentProductCard } from '../search/card.ts';

export interface MatchableCard {
  readonly title: string | null;
  readonly final_price_fen: number;
  readonly match_tag: AgentProductCard['match_tag'];
  readonly spec_text: string | null;
  readonly benefit_tags: readonly string[];
  readonly coupon_fen: number;
  readonly is_presale: boolean;
}

/** B3-05g 提供用户原始条件及本轮是否已经放宽。 */
export interface MatchConditions {
  readonly spec?: string;
  readonly priceMinFen?: number;
  readonly priceMaxFen?: number;
  readonly relaxed: boolean;
}

/**
 * 找货结果核对（Jev，BR-AI-14 / BR-AI-24 细则）。每轮整组 1 次请求，只发标题与需求短词。
 * 现在只带 spec；由需求提炼的品类短词随 B3-12 补。
 */
export interface ResultCheckPort {
  check(
    items: readonly { title: string }[],
    need: { spec?: string },
    signal: AbortSignal,
  ): Promise<readonly ('consistent' | 'inconsistent' | 'unsure')[]>;
}

export interface MatchDeps {
  provider(appId: string): Promise<'rules' | 'jev'>;
  readonly resultCheck?: ResultCheckPort;
  readonly timeoutMs?: () => number;
  readonly scheduler: Scheduler;
}

/** BR-AI-14 细则：在线调用硬超时 400ms（未注入 timeoutMs 时的默认值）。 */
const DEFAULT_CHECK_TIMEOUT_MS = 400;

type Verdict = 'consistent' | 'inconsistent' | 'unsure';

/** BR-AI-24 按优先级判定；保持卡片数量、顺序和其余字段，不修改入参。 */
export async function assignMatchTags<T extends MatchableCard>(
  cards: readonly T[],
  conditions: MatchConditions,
  appId: string,
  deps: MatchDeps,
): Promise<readonly T[]> {
  const spec = givenSpec(conditions.spec);
  const coded = cards.map((card) => ({
    ...card,
    ...codeTag(card, conditions, spec),
    benefit_tags: agentBenefitTags(card),
  }));
  if (coded.length === 0) return coded;

  const provider = await readProvider(deps, appId);
  // provider=jev 但还没注入核对端口（B3-12 接线前）时按 rules 处理：不调 Jev、不降级。
  // 保守做法——开关先打开时不能让所有卡片一起降级为「规格待确认」。
  if (provider !== 'jev' || deps.resultCheck === undefined) return coded;

  const verdicts = await checkWithDeadline(
    deps.resultCheck,
    deps,
    cards.map((card) => ({ title: card.title ?? '' })),
    spec === undefined ? {} : { spec },
  );
  // Jev 结论只能把 matched 降为 spec_unconfirmed：不剔除、不改顺序、不升级（BR-AI-24 细则）。
  // 超时、失败、张数不符按 BR-AI-24 的「超时 → spec_unconfirmed」从严处理（任务书 §9 默认）。
  return coded.map((card, index) =>
    card.match_tag === 'matched' && verdicts?.[index] !== 'consistent'
      ? { ...card, match_tag: 'spec_unconfirmed' as const, spec_text: null }
      : card,
  );
}

/** 服务端生成的权益标签（BR-AI-24、AI-08）：只看券额与预售事实，不含推荐理由、规格文字或数字。 */
export function agentBenefitTags(card: MatchableCard): readonly string[] {
  const tags: string[] = [];
  if (card.coupon_fen > 0) tags.push('有券');
  if (card.is_presale) tags.push('预售');
  return tags;
}

/** 只含空白的 spec 视为用户没给规格。 */
function givenSpec(spec: string | undefined): string | undefined {
  return spec === undefined || spec.trim() === '' ? undefined : spec;
}

/** BR-AI-24 判定表，从上到下取第一个；旧的 match_tag / spec_text 不参与。 */
function codeTag(
  card: MatchableCard,
  conditions: MatchConditions,
  spec: string | undefined,
): Pick<MatchableCard, 'match_tag' | 'spec_text'> {
  const fragment = spec === undefined ? null : findSpecInTitle(spec, card.title ?? '');
  const violatesSpec = spec !== undefined && fragment === null;
  // BR-AI-08：闭区间 price_min_fen ≤ final_price_fen ≤ price_max_fen。
  const price = card.final_price_fen;
  const violatesPrice =
    (conditions.priceMinFen !== undefined && price < conditions.priceMinFen) ||
    (conditions.priceMaxFen !== undefined && price > conditions.priceMaxFen);
  if (conditions.relaxed && (violatesSpec || violatesPrice)) {
    return { match_tag: 'relaxed', spec_text: null };
  }
  if (violatesSpec) return { match_tag: 'spec_unconfirmed', spec_text: null };
  return { match_tag: 'matched', spec_text: fragment };
}

/** provider 读取失败按默认 rules（BR-AI-24 细则：agent.result_check.provider 默认 rules）。 */
async function readProvider(deps: MatchDeps, appId: string): Promise<'rules' | 'jev'> {
  try {
    return (await deps.provider(appId)) === 'jev' ? 'jev' : 'rules';
  } catch {
    return 'rules';
  }
}

/**
 * 整组核对 1 次，不重试。到点即中止请求并返回 null（未知），不等端口配合中止；
 * 迟到的结论被丢弃。端口抛错、拒绝、张数不符或取值不认识同样返回 null。
 */
async function checkWithDeadline(
  port: ResultCheckPort,
  deps: MatchDeps,
  items: readonly { title: string }[],
  need: { spec?: string },
): Promise<readonly Verdict[] | null> {
  let budget: unknown = DEFAULT_CHECK_TIMEOUT_MS;
  if (deps.timeoutMs !== undefined) {
    try {
      budget = deps.timeoutMs();
    } catch {
      return null;
    }
  }
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) return null;

  const request = new AbortController();
  const timer = new AbortController();
  const expired = new Promise<'expired'>((resolve) => {
    deps.scheduler.sleep(budget, timer.signal).then(
      () => {
        resolve('expired');
      },
      () => {
        // 计时器被取消：核对已先结束，这个分支不再参与竞争。
      },
    );
  });
  const work = (async (): Promise<readonly Verdict[] | null> => {
    const result: unknown = await port.check(items, need, request.signal);
    if (!Array.isArray(result) || result.length !== items.length) return null;
    return result.map((value: unknown): Verdict =>
      value === 'consistent' || value === 'inconsistent' ? value : 'unsure',
    );
  })().catch(() => null);

  const outcome = await Promise.race([work, expired]);
  if (outcome === 'expired') {
    request.abort();
    return null;
  }
  timer.abort();
  return outcome;
}
