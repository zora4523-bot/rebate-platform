// B1-08j：来源回填的纯匹配（BR-ATTR-15；窗口 BR-ATTR-13 ③；点击证据 BR-ATTR-14）。不做 I/O：
// 调用方经端口取 link 与 link_logs 原始行，判定全部在这里。匹配顺序命中即停：
// ① exact：订单参数里的 lk 反查到的 link 属于订单 user_id；
// ② product / ③ shop：同 user_id、同平台、event ∈ {convert, open}、result_code=0、pid_scene 与订单推广位一致
//   （推广位本身是 fallback 时不限；推广位场景未知时 ② / ③ 不匹配，不跨场景）、
//   created_at ∈ [attr_at − W_backfill, attr_at]（两端闭，绝对时长）；
//   ② 另要同 product_key，③ 另要同 shop_id；取 created_at 最大，同刻取 id 最大；
// ④ none：三个来源字段置空。
import type { RegisteredPlatform, UnionOrderAttrParams } from '../../union/index.ts';
import { JD_SUB_UNION, parseJsonObject } from './attribution.ts';

export interface ExactLink {
  readonly link_id: string;
  readonly user_id: string | null;
  readonly scene: string | null;
  readonly agent_session_id: string | null;
}

export interface LinkLogCandidate extends Omit<ExactLink, 'link_id'> {
  readonly link_id: string | null;
  readonly id: bigint;
  readonly event: string;
  readonly platform: string | null;
  readonly product_key: string | null;
  readonly shop_id: string | null;
  readonly pid_scene: string | null;
  readonly result_code: number | null;
  readonly created_at: Date;
}

export interface MatchOrderSourceInput {
  readonly userId: string;
  readonly platform: RegisteredPlatform;
  readonly productKey: string | null;
  readonly shopId: string | null;
  /**
   * 订单推广位的 pid_scene。null = 推广位场景未知（推广位为空或查不到推广位行）：② / ③ 不匹配
   * （08 只对 fallback 推广位不限场景，未知不等于 fallback），只看 ① exact，否则 ④ none。
   */
  readonly pidScene: string | null;
  readonly attrAt: Date;
  readonly windowHours: number;
  readonly exactLink: ExactLink | null;
  readonly candidates: readonly LinkLogCandidate[];
}

export interface OrderSourceMatch {
  readonly source_match: 'exact' | 'product' | 'shop' | 'none';
  readonly link_id: string | null;
  readonly source_scene: string | null;
  readonly agent_session_id: string | null;
}

/** BR-ATTR-13 ③ 配置 attr.backfill_window_hours 的默认值（暂定，待 CAP-*-05 回写）。 */
export const DEFAULT_BACKFILL_WINDOW_HOURS = 360;

/** BR-ATTR-14：只有这两种事件（且 result_code=0）算点击证据；precompute、register 不算。 */
const CLICK_EVENTS: ReadonlySet<string> = new Set(['convert', 'open']);

/**
 * 订单推广位本身是 fallback 时 ② / ③ 不限 pid_scene（BR-ATTR-15 ②）；其余取值按字面比较（待裁定 6）；
 * 推广位场景未知（null）不当作 fallback。
 */
const FALLBACK_PID_SCENE = 'fallback';

/** BR-ATTR-15 lk：1–16 位 [0-9a-z]（BR-ATTR-06 解析口径，便于将来调长）。 */
const LINK_CODE = /^[0-9a-z]{1,16}$/;

const HOUR_MS = 3_600_000;

const NONE: OrderSourceMatch = {
  source_match: 'none',
  link_id: null,
  source_scene: null,
  agent_session_id: null,
};

/** created_at 大者优先；同刻比 bigint id（不经浮点）。 */
function isLater(a: LinkLogCandidate, b: LinkLogCandidate): boolean {
  const diff = a.created_at.getTime() - b.created_at.getTime();
  if (diff !== 0) return diff > 0;
  return a.id > b.id;
}

function latest(rows: readonly LinkLogCandidate[]): LinkLogCandidate | null {
  let best: LinkLogCandidate | null = null;
  for (const row of rows) {
    if (best === null || isLater(row, best)) best = row;
  }
  return best;
}

function fromLog(row: LinkLogCandidate, kind: 'product' | 'shop'): OrderSourceMatch {
  return {
    source_match: kind,
    link_id: row.link_id,
    source_scene: row.scene,
    agent_session_id: row.agent_session_id,
  };
}

/**
 * BR-ATTR-15 ① exact：lk 反查到的 link 属于订单 user_id → 直接取这个 link；反查不到、link 无主或
 * 属于他人 → null（不算 exact，继续 ②）。用例层据此在命中时即停，不再读后续端口。
 */
export function matchExactLink(
  exactLink: ExactLink | null,
  userId: string,
): OrderSourceMatch | null {
  if (exactLink === null || exactLink.user_id === null || exactLink.user_id !== userId) {
    return null;
  }
  return {
    source_match: 'exact',
    link_id: exactLink.link_id,
    source_scene: exactLink.scene,
    agent_session_id: exactLink.agent_session_id,
  };
}

/** BR-ATTR-15 ①～④（命中即停）。不改输入，不对候选原地排序。 */
export function matchOrderSource(input: MatchOrderSourceInput): OrderSourceMatch {
  const exact = matchExactLink(input.exactLink, input.userId);
  if (exact !== null) return exact;
  const pidScene = input.pidScene;
  // 推广位场景未知：② / ③ 不跨场景匹配（D10-60），直接 ④ none。
  if (pidScene === null) return { ...NONE };
  const toMs = input.attrAt.getTime();
  const fromMs = toMs - input.windowHours * HOUR_MS;
  const anyScene = pidScene === FALLBACK_PID_SCENE;
  const clicks = input.candidates.filter((row) => {
    if (row.user_id === null || row.user_id !== input.userId) return false;
    if (row.platform !== input.platform) return false;
    if (!CLICK_EVENTS.has(row.event) || row.result_code !== 0) return false;
    const createdMs = row.created_at.getTime();
    if (!(createdMs >= fromMs && createdMs <= toMs)) return false;
    return anyScene || (row.pid_scene !== null && row.pid_scene === pidScene);
  });
  const productKey = input.productKey;
  if (productKey !== null) {
    const hit = latest(clicks.filter((row) => row.product_key === productKey));
    if (hit !== null) return fromLog(hit, 'product');
  }
  const shopId = input.shopId;
  if (shopId !== null) {
    const hit = latest(clicks.filter((row) => row.shop_id === shopId));
    if (hit !== null) return fromLog(hit, 'shop');
  }
  return { ...NONE };
}

/**
 * BR-ATTR-15 lk：只看本平台自己的参数字段。京东取 subUnionId（BR-ATTR-06 整串格式）的第 2 组；
 * 拼多多取 custom_parameters（JSON 对象）的 lk，须是 1–16 位 [0-9a-z] 字符串；其余平台 null。
 */
// TODO(规划/11 §4.5): 美团 sid 的 lk 解析 — blocked on 美团联盟适配器（RegisteredPlatform 未含美团）
export function parseLinkCode(
  platform: RegisteredPlatform,
  attrParams: UnionOrderAttrParams,
): string | null {
  if (platform === 'jd') {
    const sub = attrParams.sub_union_id;
    if (typeof sub !== 'string') return null;
    return JD_SUB_UNION.exec(sub)?.[2] ?? null;
  }
  if (platform === 'pdd') {
    const lk = parseJsonObject(attrParams.custom_parameters)?.['lk'];
    return typeof lk === 'string' && LINK_CODE.test(lk) ? lk : null;
  }
  return null;
}
