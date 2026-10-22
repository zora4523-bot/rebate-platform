// B3-08d · BR-AI-01 / BR-AI-03 / BR-AI-14: prefill_claim, a read-only claim draft. The model gives
// platform + order_no (order_no may hold this run's <num_k> placeholders, restored here and only
// format-checked: no order lookup, no unattributed pool, no claim write, no link open). The card
// echoes platform, order_no and the caller's own successful convert/open times from link_logs;
// evidence_summary is always null. Submitting is a B-level client action (submit_claim).
// Identity comes only from ToolCallContext.
import type { ClaimEntryLog, ClaimEntryReader } from '../../../linking/index.ts';
import type { Clock } from '../../../platform/index.ts';
import type { ToolOutcome } from '../../orchestrator/index.ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import type { ToolCallContext, ToolDefinition, ToolHandler } from '../registry/index.ts';

/** B3-08d: read-only draft preparation; no order lookup or claim submission port. */
export interface ClaimDraftDeps {
  readonly clicks: Pick<ClaimEntryReader, 'read'>;
  readonly clock: Clock;
  readonly config: (appId: string, key: string) => Promise<unknown>;
  readonly platforms: readonly string[];
  readonly cardReference?: (ctx: ToolCallContext, index: number) => string;
  readonly texts?: (appId: string, key: string) => Promise<string>;
}

function toolName(): 'prefill_claim' {
  return 'prefill_claim';
}

/** Task brief §9 default: the dictionary key is added by the copy line. */
function submitTextKey(): string {
  return 'agent.card.claim_draft.submit';
}

/** Card frame fallback for clients that cannot render claim_draft: no order number, no time. */
function fallbackText(): string {
  return '已为你准备好订单找回草稿，请在卡片中核对后提交。';
}

/** Order number length limit, checked again after placeholder restoration. */
function maxOrderNoLength(): number {
  return 64;
}

/** BR-ATTR-13 ④ default of claim.window_hours (same value as orders' claim rules). */
function defaultWindowHours(): number {
  return 720;
}

/** Task brief §9 default: at most this many click times on the card. */
function maxClickTimes(): number {
  return 10;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejected(): ToolOutcome {
  return { kind: 'rejected', modelView: { error: 'invalid_args' } };
}

/** Generic failure view: no message or stack reaches the model. */
function failed(): ToolOutcome {
  return { kind: 'failed', modelView: { error: 'tool_failed' } };
}

/** Closed schema (BR-AI-03): platform from the enabled list, order_no as text, nothing else. */
function definition(platforms: readonly string[]): ToolDefinition {
  return {
    name: toolName(),
    description:
      '为用户准备一张订单找回草稿卡，由用户在卡片上确认提交。platform 为订单所属平台；' +
      'order_no 为用户提供的订单号，可原样使用对话中的 <num_k> 占位符。' +
      '本工具不查询订单是否存在，也不会提交找回。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['platform', 'order_no'],
      properties: {
        platform: { type: 'string', enum: [...platforms] },
        order_no: { type: 'string', minLength: 1, maxLength: maxOrderNoLength() },
      },
    },
  };
}

/** Same normalisation as the claim endpoint's input step: drop ASCII spaces only. */
function stripSpaces(orderNo: string): string {
  return orderNo.replaceAll(' ', '');
}

/**
 * BR-AI-14: restores every <num_k> token, whole or embedded, from this run's table only. Any token
 * missing from the table refuses the call (null); the table itself is never modified.
 */
function restoreOrderNo(value: string, table: Readonly<Record<string, string>>): string | null {
  let restored = '';
  let last = 0;
  for (const match of value.matchAll(/<num_[1-9]\d*>/gu)) {
    const token = match[0];
    const raw = Object.hasOwn(table, token) ? table[token] : undefined;
    if (typeof raw !== 'string') return null;
    restored += value.slice(last, match.index) + raw;
    last = match.index + token.length;
  }
  return restored + value.slice(last);
}

/** Format check only (BR-AI-03 exception): non-empty after space removal and within 64. */
function normalizeOrderNo(value: string): string | null {
  const orderNo = stripSpaces(value);
  return orderNo.length > 0 && orderNo.length <= maxOrderNoLength() ? orderNo : null;
}

function windowHours(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : defaultWindowHours();
}

async function readWindowHours(deps: ClaimDraftDeps, appId: string): Promise<number> {
  try {
    return windowHours(await deps.config(appId, 'claim.window_hours'));
  } catch {
    // Unreadable setting: the default window, the draft still goes out.
    return defaultWindowHours();
  }
}

/** `instant` moved by `ms` as a fresh Date (the input is never modified, no wall clock read). */
function shiftMs(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + ms);
  return result;
}

/** 04 §5 timestamp: the same instant expressed with the fixed +08:00 offset. */
function plusEight(at: Date): string {
  const shifted = shiftMs(at, 8 * 3_600_000).toISOString();
  return `${shifted.slice(0, -1)}+08:00`;
}

function isOwnSuccessfulJump(log: ClaimEntryLog, platform: string): boolean {
  return (
    log.platform === platform &&
    (log.event === 'convert' || log.event === 'open') &&
    log.result_code === 0
  );
}

/**
 * Shared card builder for prefill_claim and explain_order's independently decided miss. Reads only
 * the caller's own link jumps (subject from ctx) in [now − claim.window_hours, now]; a reader
 * failure propagates, so no half card is built.
 */
export async function claimDraftCard(
  deps: ClaimDraftDeps,
  ctx: ToolCallContext,
  input: { readonly platform: string; readonly orderNo: string },
): Promise<UnnumberedCard> {
  const userId = ctx.userId;
  if (userId === null) throw new Error('claimDraftCard: a signed-in user is required');
  const orderNo = normalizeOrderNo(input.orderNo);
  if (orderNo === null) throw new Error('claimDraftCard: order number is not well formed');
  const hours = await readWindowHours(deps, ctx.appId);
  const to = deps.clock.now();
  const from = shiftMs(to, -hours * 3_600_000);
  const { logs } = await deps.clicks.read({ app_id: ctx.appId, user_id: userId, from, to });
  const clickTimes = logs
    .filter((log) => isOwnSuccessfulJump(log, input.platform))
    .map((log) => log.created_at)
    .sort((a, b) => b.getTime() - a.getTime())
    .slice(0, maxClickTimes())
    .map(plusEight);
  return {
    type: 'claim_draft',
    schema_version: 1,
    data: {
      platform: input.platform,
      order_no: orderNo,
      click_times: clickTimes,
      evidence_summary: null,
      submit_action: { text_key: submitTextKey(), action: 'submit_claim' },
    },
    fallback_text: fallbackText(),
  };
}

/** Model arguments: platform and order_no only; the order number is echoed, never looked up. */
export function createPrefillClaimHandler(deps: ClaimDraftDeps): ToolHandler {
  async function run(
    args: Readonly<Record<string, unknown>>,
    ctx: ToolCallContext,
  ): Promise<ToolOutcome> {
    if (!isRecord(args)) return rejected();
    const platform = args['platform'];
    const value = args['order_no'];
    if (typeof platform !== 'string' || !deps.platforms.includes(platform)) return rejected();
    if (typeof value !== 'string') return rejected();
    const restored = restoreOrderNo(value, ctx.placeholders);
    if (restored === null) return rejected();
    const orderNo = normalizeOrderNo(restored);
    if (orderNo === null) return rejected();
    let card: UnnumberedCard;
    try {
      card = await claimDraftCard(deps, ctx, { platform, orderNo });
    } catch {
      return failed();
    }
    // The card is the only entry of outcome.cards; the model sees its reference, never the number.
    const cards = [card];
    const reference = deps.cardReference;
    return {
      kind: 'ok',
      modelView: reference === undefined ? {} : { card_id: reference(ctx, cards.indexOf(card)) },
      cards,
    };
  }

  return { name: toolName(), definition: definition(deps.platforms), audience: 'phone_bound', run };
}
