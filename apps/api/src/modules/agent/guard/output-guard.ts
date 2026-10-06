// OutputGuard (BR-AI-06 filter, sentence buffer and ≤2 sentences; BR-AI-18 output-side review).
// No IO: the review port is injected and timed by its adapter (B3-06b).
import {
  EMPTY_COUNT,
  countStep,
  createSentenceBuffer,
  finalCount,
  hasOpenSentence,
} from './buffer.ts';
import type { SentenceCount } from './buffer.ts';
import { filterAfter } from './filter.ts';
import type { FilterHit } from './filter.ts';

export const MAX_SENTENCES = 2;

export type ReviewVerdict = 'pass' | 'block' | 'timeout';
export interface SentenceReviewPort {
  review(text: string): Promise<ReviewVerdict>;
}
export type GuardEmit =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'fixed';
      readonly key: 'agent.refuse.output_blocked' | 'agent.refuse.safety_timeout';
    };
export interface GuardSummary {
  readonly outputFiltered: boolean;
  readonly filterHits: readonly FilterHit[];
  readonly outputTruncated: boolean;
  readonly safety: 'none' | 'blocked' | 'timeout_replaced';
}
export interface OutputGuard {
  push(delta: string): Promise<GuardEmit[]>;
  end(): Promise<GuardEmit[]>;
  readonly stopped: boolean;
  summary(): GuardSummary;
}

const BLOCKED: GuardEmit = { kind: 'fixed', key: 'agent.refuse.output_blocked' };
const TIMED_OUT: GuardEmit = { kind: 'fixed', key: 'agent.refuse.safety_timeout' };
const CONTEXT_UNITS = 96;
const MEANINGLESS = /^[\s\p{P}]*$/u;

async function reviewSafely(port: SentenceReviewPort, text: string): Promise<ReviewVerdict> {
  try {
    const verdict = await port.review(text);
    return verdict === 'pass' || verdict === 'block' ? verdict : 'timeout';
  } catch {
    // Fail-close (O-G8): a throwing port counts as a timeout.
    return 'timeout';
  }
}

function tailOf(text: string): string {
  if (text.length <= CONTEXT_UNITS) return text;
  let start = text.length - CONTEXT_UNITS;
  const unit = text.charCodeAt(start);
  if (unit >= 0xdc00 && unit <= 0xdfff) start += 1;
  return text.slice(start);
}

export function createOutputGuard(deps: { readonly review: SentenceReviewPort }): OutputGuard {
  const buffer = createSentenceBuffer();
  const hits: FilterHit[] = [];
  let count: SentenceCount = EMPTY_COUNT;
  let context = '';
  let copySeen = false;
  let truncated = false;
  let cutOff = false;
  let stopped = false;
  let ended = false;
  let held: string | null = null;
  let safety: GuardSummary['safety'] = 'none';

  const commit = (text: string, next: SentenceCount): void => {
    count = next;
    if (!copySeen && (context.slice(-1) + text).includes('复制')) copySeen = true;
    context = tailOf(context + text);
  };

  /** Filters one raw segment and returns the part that may be delivered, with its count. */
  const prepare = (segment: string): { text: string; next: SentenceCount } | null => {
    const filtered = filterAfter(context, segment, copySeen);
    for (const hit of filtered.hits) if (!hits.includes(hit)) hits.push(hit);
    const text = filtered.text;
    if (MEANINGLESS.test(text) && !hasOpenSentence(count)) return null;
    let state = count;
    let offset = 0;
    for (const ch of text) {
      const next = countStep(state, ch);
      if (finalCount(next) > MAX_SENTENCES) {
        truncated = true;
        cutOff = true;
        break;
      }
      state = next;
      offset += ch.length;
    }
    const kept = text.slice(0, offset);
    if (kept === '' || (MEANINGLESS.test(kept) && !hasOpenSentence(count))) return null;
    return { text: kept, next: state };
  };

  const handle = async (segment: string, out: GuardEmit[]): Promise<void> => {
    if (stopped || cutOff) return;
    const prepared = prepare(segment);
    if (prepared === null) return;
    if (held !== null) {
      held += prepared.text;
      commit(prepared.text, prepared.next);
      return;
    }
    const verdict = await reviewSafely(deps.review, prepared.text);
    if (verdict === 'pass') {
      commit(prepared.text, prepared.next);
      out.push({ kind: 'text', text: prepared.text });
    } else if (verdict === 'block') {
      stopped = true;
      safety = 'blocked';
      out.push(BLOCKED);
    } else {
      held = prepared.text;
      commit(prepared.text, prepared.next);
    }
  };

  return {
    async push(delta) {
      const out: GuardEmit[] = [];
      if (ended || stopped) return out;
      for (const segment of buffer.push(delta)) {
        await handle(segment, out);
        if (stopped) break;
      }
      return out;
    },
    async end() {
      const out: GuardEmit[] = [];
      if (ended || stopped) return out;
      ended = true;
      for (const segment of buffer.end()) {
        await handle(segment, out);
        if (stopped) return out;
      }
      if (held !== null) {
        const text = held;
        held = null;
        const verdict = await reviewSafely(deps.review, text);
        if (verdict === 'pass') {
          out.push({ kind: 'text', text });
        } else if (verdict === 'block') {
          stopped = true;
          safety = 'blocked';
          out.push(BLOCKED);
        } else {
          safety = 'timeout_replaced';
          out.push(TIMED_OUT);
        }
      }
      return out;
    },
    get stopped() {
      return stopped;
    },
    summary() {
      return {
        outputFiltered: hits.length > 0,
        filterHits: [...hits],
        outputTruncated: truncated,
        safety,
      };
    },
  };
}
