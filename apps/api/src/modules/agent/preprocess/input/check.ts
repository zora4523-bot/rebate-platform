// B3-05d · BR-AI-18 / BR-AI-01 / BR-AI-05: the InputCheckPort of B3-05b.
//
// Order (BR-AI-01 细则「判定顺序」第 1 步): input review first, on the B3-05a model form of the
// whole message (untrusted share text included; links and passwords are removed by redactForModel); nothing is decided before a `pass` arrives. Then
// the advice pre-check, then the prohibited query words, then the page_guide input-source flags.
// Review failure of any kind (verdict timeout, throw, unknown verdict, the deadline, an aborted
// run) is fail-close and refunded: agent.refuse.safety_unavailable + ending input_review_timeout.
import type { Scheduler } from '../../../platform/index.ts';
import { wrapUntrusted } from '../../guard/index.ts';
import type { SentenceReviewPort } from '../../guard/index.ts';
import type { AgentRunTexts, InputCheckPort, InputCheckResult } from '../../orchestrator/index.ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import { createKeywordMatcher, inputKeywordLists, normalizeForKeywords } from './keywords.ts';
import { createParamDetector, pageGuideParamPatterns } from './params.ts';
import { redactForModel } from '../redact/index.ts';
import { findCandidates, selectCandidates, withoutCandidates } from './text.ts';

export interface InputCheckDeps {
  readonly review: SentenceReviewPort;
  readonly scheduler: Scheduler;
  /** agent.safety.timeout_ms；未提供时使用 BR-AI-18 的默认 1000ms。 */
  readonly timeoutMs?: () => number;
  readonly texts: Pick<AgentRunTexts, 'text'>;
}

/** BR-AI-18 default for agent.safety.timeout_ms. */
const DEFAULT_TIMEOUT_MS = 1000;
/** BR-AI-01 parse_input row: links and passwords handled per message (same as parsing MAX_CANDIDATES). */
const LINK_LIMIT = 3;
const LINK_LIMIT_KEY = 'agent.notice.link_limit';

// BR-AI-05: explicitly labelled pasted share text or material is untrusted even without a link.
const SHARE_LABEL_RE = /(?:分享文案|分享内容|商品素材|推广文案|商品文案|素材文案|素材)\s*[:：]/u;

type ReviewOutcome = 'pass' | 'block' | 'unavailable';

function refuse(textKey: string): InputCheckResult {
  return { kind: 'refuse', textKey, finishReason: 'safety' };
}

function unavailable(): InputCheckResult {
  return {
    kind: 'refuse',
    textKey: 'agent.refuse.safety_unavailable',
    finishReason: 'safety',
    ending: 'input_review_timeout',
  };
}

function timeoutOf(deps: InputCheckDeps): number {
  const configured = deps.timeoutMs?.();
  return configured !== undefined && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TIMEOUT_MS;
}

/** First settled of the verdict and the deadline; a late verdict is ignored. */
async function reviewWithin(
  deps: InputCheckDeps,
  text: string,
  signal: AbortSignal,
): Promise<ReviewOutcome> {
  const timer = new AbortController();
  const stop = () => {
    timer.abort();
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const verdict = Promise.resolve()
      .then(() => deps.review.review(text))
      .then(
        (value): ReviewOutcome => (value === 'pass' || value === 'block' ? value : 'unavailable'),
        (): ReviewOutcome => 'unavailable',
      );
    const deadline = deps.scheduler.sleep(timeoutOf(deps), timer.signal).then(
      (): ReviewOutcome => 'unavailable',
      (): ReviewOutcome => 'unavailable',
    );
    const outcome = await Promise.race([verdict, deadline]);
    return signal.aborted ? 'unavailable' : outcome;
  } finally {
    timer.abort();
    signal.removeEventListener('abort', stop);
  }
}

export function createInputCheck(deps: InputCheckDeps): InputCheckPort {
  const keywords = createKeywordMatcher(inputKeywordLists());
  const params = createParamDetector(pageGuideParamPatterns());

  const linkNotice = async (appId: string): Promise<UnnumberedCard> => ({
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: LINK_LIMIT_KEY, actions: [] },
    fallback_text: await deps.texts.text(appId, LINK_LIMIT_KEY),
  });

  return {
    async check(input, signal) {
      const message = input.text;
      const all = findCandidates(message);
      // Everything the user typed outside links and passwords, unredacted (parameter evidence and
      // keywords are judged on the original, BR-AI-01 / BR-AI-18).
      const freeText = withoutCandidates(message, all);
      // B3-05a model form (links and passwords removed, BR-AI-14 table incl. addresses, per-call
      // placeholders): the review and the model see exactly the same text.
      const { text: redacted, placeholders } = redactForModel(message);
      const untrustedInput = all.length > 0 || SHARE_LABEL_RE.test(freeText);

      const outcome = await reviewWithin(deps, redacted, signal);
      if (outcome === 'unavailable') return unavailable();
      if (outcome === 'block') return refuse('agent.refuse.unsafe');

      const normalized = normalizeForKeywords(freeText);
      if (keywords.hits('advice', normalized)) return refuse('agent.refuse.advice');
      if (keywords.hits('prohibited', normalized)) return refuse('agent.refuse.prohibited');

      const { kept, dropped } = selectCandidates(all, LINK_LIMIT);
      const notices: UnnumberedCard[] = dropped > 0 ? [await linkNotice(input.caller.appId)] : [];

      return {
        kind: 'proceed',
        modelText: untrustedInput ? wrapUntrusted(redacted) : redacted,
        placeholders: { ...placeholders },
        links: kept,
        notices,
        untrustedInput,
        paramsRequested: params.test(freeText),
      };
    },
  };
}
