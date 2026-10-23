import { expect, vi } from 'vitest';
import type { ClaimEntryReader } from '../../../../apps/api/src/modules/linking/index.ts';
import type {
  AgentCapableOrderQueries,
  AgentOrderItem,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type {
  ToolContext,
  ToolOutcome,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { UnnumberedCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { createFrameValidator } from '../../../../apps/api/src/modules/agent/stream/writer/index.ts';
import type { ClaimDraftDeps } from '../../../../apps/api/src/modules/agent/tools/claim/index.ts';
import {
  createExplainOrderHandler,
  createListMyOrdersHandler,
  type OrderCardRefs,
  type OrderNoQuota,
  type OrderToolsDeps,
} from '../../../../apps/api/src/modules/agent/tools/orders/index.ts';
import {
  createToolRegistry,
  type ToolCallContext,
  type ToolSwitches,
} from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';

// 合成时钟：UTC 10-23 12:00 = +08:00 10-23 20:00。
export const NOW = '2026-10-23T12:00:00.000Z';
export const rejected = { kind: 'rejected', modelView: { error: 'invalid_args' } };
export const toolFailed = { kind: 'failed', modelView: { error: 'tool_failed' } };
export const LIST = 'list_my_orders';
export const EXPLAIN = 'explain_order';

export type OrderDetail = NonNullable<Awaited<ReturnType<AgentCapableOrderQueries['get']>>>;

export function context(patch: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    appId: 'synthetic-app',
    userId: 'synthetic-user',
    deviceId: 'synthetic-device',
    phoneBound: true,
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    placeholders: {},
    ...patch,
  };
}

export function caller(ctx: ToolCallContext): AgentCaller {
  return {
    appId: ctx.appId,
    userId: ctx.userId,
    deviceId: ctx.deviceId,
    phoneBound: ctx.phoneBound,
    deviceHash: 'synthetic-device-hash',
    ipKey: 'synthetic-ip-key',
    traceId: 'synthetic-trace',
  };
}

export function registryContext(ctx: ToolCallContext): ToolContext {
  return {
    subject: caller(ctx),
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    signal: ctx.signal,
    placeholders: ctx.placeholders,
  };
}

/** 卡引用不含数字，便于断言模型视图里没有金额、日期、单号。 */
export function reference(index: number): string {
  return `card-ref-${String.fromCharCode(97 + index)}`;
}

/** card_order_status 的 8 个字段（B3-08f AgentOrderItem），合成值。 */
export function item(patch: Partial<AgentOrderItem> = {}): AgentOrderItem {
  return {
    order_id: '0192f3a1-7c00-7000-8000-00000000a001',
    platform: 'jd',
    title: '合成纯牛奶整箱',
    is_other_product: false,
    display_status: 'PAID',
    reason: null,
    est_rebate_fen: 1234,
    expected_credit_period: null,
    ...patch,
  };
}

/** 本人自购单详情（含 card_order_status 之外的字段：单号、付款时间、实返、图片等）。 */
export function selfDetail(): OrderDetail {
  return {
    order_id: '0192f3a1-7c00-7000-8000-00000000b001',
    platform: 'taobao',
    title: '合成燕麦片家庭装',
    image_url: 'https://img.example.invalid/synthetic-oat.jpg',
    pay_amount_fen: 4590,
    quantity: 2,
    order_no: '3900112233445566778',
    display_status: 'WAITING',
    reason: 'PART_REFUND',
    est_rebate_fen: 321,
    paid_at: '2026-10-20T10:11:12.000Z',
    is_other_product: false,
    product_key: 'tb:synthetic-oat',
    reason_action: ['VIEW_DETAIL'],
    timeline: [],
    expected_credit_period: '2026-12',
    credit_overdue: false,
    actual_fen: 300,
    clawback_fen: 21,
    appeal_pending: false,
    is_price_compare: false,
  };
}

/** 本人分享单、好友买了其他商品：orders 已按投影给出 title=null、只有打码单号。 */
export function shareDetail(): OrderDetail {
  return {
    order_id: '0192f3a1-7c00-7000-8000-00000000c001',
    platform: 'pdd',
    title: null,
    image_url: null,
    pay_amount_fen: 2990,
    quantity: 1,
    masked_order_no: '231023-****5678',
    display_status: 'CREDITING',
    reason: null,
    est_rebate_fen: 88,
    paid_at: '2026-10-19T08:00:00.000Z',
    is_other_product: true,
    product_key: null,
    reason_action: [],
    timeline: [],
    expected_credit_period: '2026-11',
    credit_overdue: false,
    actual_fen: null,
    clawback_fen: null,
    appeal_pending: false,
    is_price_compare: null,
  };
}

export function fixture(patch: Partial<OrderToolsDeps> = {}) {
  const clock = new FixedClock(NOW);
  const searchForAgent = vi.fn<AgentCapableOrderQueries['searchForAgent']>(async () => ({
    orders: [],
    total: 0,
  }));
  const findOwnByNumber = vi.fn<AgentCapableOrderQueries['findOwnByNumber']>(async () => []);
  const get = vi.fn<AgentCapableOrderQueries['get']>(async () => null);
  const resolve = vi.fn<OrderCardRefs['resolve']>(async () => ({ kind: 'invalid' }));
  const take = vi.fn<OrderNoQuota['take']>(async () => true);
  const config = vi.fn<OrderToolsDeps['config']>(async () => undefined);
  const read = vi.fn<ClaimEntryReader['read']>(async () => ({ logs: [], bindings: [] }));
  const claimConfig = vi.fn<ClaimDraftDeps['config']>(async () => undefined);
  const cardReference = vi.fn((_ctx: ToolCallContext, index: number) => reference(index));
  const claim: ClaimDraftDeps = {
    clicks: { read },
    clock,
    config: claimConfig,
    platforms: ['taobao', 'jd', 'pdd'],
    cardReference,
  };
  const deps: OrderToolsDeps = {
    orders: { searchForAgent, findOwnByNumber, get },
    refs: { resolve },
    quota: { take },
    clock,
    config,
    claim,
    handoff: { cardReference },
    cardReference,
    ...patch,
  };
  return {
    deps,
    clock,
    searchForAgent,
    findOwnByNumber,
    get,
    resolve,
    take,
    config,
    read,
    cardReference,
  };
}

/** 两个工具都注册到真实 ToolRegistry；每个测试都在断言之外先触达骨架工厂。 */
export function setup(patch: Partial<OrderToolsDeps> = {}, switches?: ToolSwitches) {
  const f = fixture(patch);
  const list = createListMyOrdersHandler(f.deps);
  const explain = createExplainOrderHandler(f.deps);
  const listRun = vi.spyOn(list, 'run');
  const explainRun = vi.spyOn(explain, 'run');
  const warn = vi.fn();
  const registry = createToolRegistry({
    handlers: [list, explain],
    switches: switches ?? { get: async () => true },
    logger: { warn },
  });
  return {
    ...f,
    list,
    explain,
    listRun,
    explainRun,
    warn,
    registry,
    execute(name: string, args: unknown, ctx = context()) {
      return registry.execute({ id: 'synthetic-call', name, args }, registryContext(ctx));
    },
  };
}

export function expectValidCard(card: UnnumberedCard): void {
  expect(card).not.toHaveProperty('card_id');
  expect(
    createFrameValidator()({
      event: 'card',
      id: 1,
      data: { ...card, seq: 1, card_id: 'c1' },
    }),
  ).toEqual({ ok: true });
}

export function okCards(outcome: ToolOutcome): readonly UnnumberedCard[] {
  expect(outcome.kind).toBe('ok');
  if (outcome.kind !== 'ok') throw new Error('Expected ok after assertion');
  for (const card of outcome.cards) expectValidCard(card);
  return outcome.cards;
}

/** 无卡：kind 不是 ok，或 ok 但 cards 为空。 */
export function expectNoCards(outcome: ToolOutcome): void {
  if (outcome.kind === 'ok') expect(outcome.cards).toEqual([]);
  else expect(outcome).not.toHaveProperty('cards');
}

export function orderCards(cards: readonly UnnumberedCard[]): readonly UnnumberedCard[] {
  return cards.filter((card) => card.type === 'order_status');
}

export function traceOrders(outcome: ToolOutcome): unknown {
  expect(outcome.kind).toBe('ok');
  if (outcome.kind !== 'ok') return undefined;
  const trace = outcome.trace as unknown as { readonly orders?: unknown } | undefined;
  return trace?.orders;
}

/** 该卡在 outcome.cards 中的下标对应的卡引用。 */
export function referenceOf(cards: readonly UnnumberedCard[], card: UnnumberedCard): string {
  const index = cards.indexOf(card);
  expect(index).toBeGreaterThanOrEqual(0);
  return reference(index);
}
