// B3-05f · BR-AI-01 / BR-AI-18: the module-internal intent output format (plan G-5).
// page_guide follows contracts/agent-stream.schema.json $defs/page_guide_intent
// (additionalProperties=false); the other intents' fields are defined in types.ts (IntentOutput).
import { platform as PLATFORM_CODES } from '@couli/contracts-ts';
import type { Platform } from '@couli/contracts-ts';
import type { ClarifySlot, IntentOutput, ParsedIntent } from './types.ts';

/** What the final text is, before shape validation. */
export type RawIntent =
  /** Not an intent object: ordinary text, a non-object JSON value or an object without an own
   * agent_intent. The core decides what to do with it. */
  | { readonly kind: 'none' }
  /** Looks like an intent object but is not valid JSON; never released as text. */
  | { readonly kind: 'broken' }
  | { readonly kind: 'object'; readonly value: Readonly<Record<string, unknown>> };

/** Trim, then remove one optional ```json / ``` fence around the whole text. */
function unfence(text: string): string {
  const body = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(body);
  return fence === null ? body : (fence[1] ?? '').trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readRawIntent(text: string): RawIntent {
  const body = unfence(text);
  if (!body.startsWith('{')) return { kind: 'none' };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return body.includes('"agent_intent"') ? { kind: 'broken' } : { kind: 'none' };
  }
  if (!isPlainObject(value) || !Object.hasOwn(value, 'agent_intent')) return { kind: 'none' };
  return { kind: 'object', value };
}

function onlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isClarifySlot(value: unknown): value is ClarifySlot {
  return value === 'reference' || value === 'price' || value === 'platform';
}

function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORM_CODES as readonly string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function refineConditions(
  value: unknown,
): Extract<IntentOutput, { agent_intent: 'refine' }>['conditions'] | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  // B3-05g: 再便宜点 / 换一批 carry no number; each flag is the literal true and stands alone.
  if (Object.hasOwn(value, 'cheaper')) {
    return keys.length === 1 && value['cheaper'] === true ? { cheaper: true } : null;
  }
  if (Object.hasOwn(value, 'next_batch')) {
    return keys.length === 1 && value['next_batch'] === true ? { next_batch: true } : null;
  }
  if (keys.length === 0 || !onlyKeys(value, ['platform', 'price_min_fen', 'price_max_fen'])) {
    return null;
  }
  const platform = value['platform'];
  const min = value['price_min_fen'];
  const max = value['price_max_fen'];
  if (platform !== undefined && !isPlatform(platform)) return null;
  if (min !== undefined && !isFiniteNumber(min)) return null;
  if (max !== undefined && !isFiniteNumber(max)) return null;
  return {
    ...(platform === undefined ? {} : { platform }),
    ...(min === undefined ? {} : { price_min_fen: min }),
    ...(max === undefined ? {} : { price_max_fen: max }),
  };
}

/** Closed-shape validation of one intent object; null when anything is missing or extra. */
export function validateIntent(value: Readonly<Record<string, unknown>>): IntentOutput | null {
  const intent = value['agent_intent'];
  switch (intent) {
    case 'page_guide': {
      const route = value['guide_route'];
      if (!onlyKeys(value, ['agent_intent', 'guide_route']) || typeof route !== 'string') {
        return null;
      }
      return { agent_intent: intent, guide_route: route };
    }
    case 'earnings_query': {
      if (!onlyKeys(value, ['agent_intent', 'topic'])) return null;
      if (!Object.hasOwn(value, 'topic')) return { agent_intent: intent };
      const topic = value['topic'];
      return topic === 'summary' || topic === 'withdrawal_progress'
        ? { agent_intent: intent, topic }
        : null;
    }
    case 'clarify': {
      const slot = value['slot'];
      if (!onlyKeys(value, ['agent_intent', 'slot']) || !isClarifySlot(slot)) return null;
      return { agent_intent: intent, slot };
    }
    case 'ref_ordinal': {
      const ordinal = value['ordinal'];
      if (!onlyKeys(value, ['agent_intent', 'ordinal'])) return null;
      if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal < 1) {
        return null;
      }
      return { agent_intent: intent, ordinal };
    }
    case 'refine': {
      if (!onlyKeys(value, ['agent_intent', 'conditions'])) return null;
      const conditions = refineConditions(value['conditions']);
      return conditions === null ? null : { agent_intent: intent, conditions };
    }
    case 'order_query':
    case 'rule_qa':
    case 'out_of_scope':
    case 'search':
    case 'find_by_link':
    case 'handoff':
      return onlyKeys(value, ['agent_intent']) ? { agent_intent: intent } : null;
    default:
      return null;
  }
}

/** Trim whitespace and one optional ```json/``` fence. Non-objects or objects lacking an own
 * agent_intent return kind:none. Recognizable but malformed/unknown intents return null;
 * handle consumes them, never releases their raw text. Invalid page-guide objects retain their
 * rejection reason in handle (extra_fields / not_allowed), even though this parser returns null.
 */
export function parseIntentOutput(text: string): ParsedIntent | null {
  const raw = readRawIntent(text);
  if (raw.kind === 'none') return { kind: 'none' };
  if (raw.kind === 'broken') return null;
  const value = validateIntent(raw.value);
  return value === null ? null : { kind: 'intent', value };
}
