// B3-03p · BR-AI-18 (followups 52, 53): the output-side sentence review of the stream entry, per
// app. createStreamReview's sentence review keeps one budget fixed at build time; this one reads
// agent.safety.timeout_ms of each run's app through deps.config (content's configuration reader),
// for every run, and lets the wait for that read count toward the same deadline as the review.
// The stream entry hands it to the core as AgentRunBodyDeps.outputReview (createStreamReview's
// ports carry it to the business assembly; production: createProductionStreamAssembly).
import type { RunSentenceReviewPort } from '../../orchestrator/core/ports.ts';
import type { StreamReviewDeps } from './review.ts';

/**
 * forRun(appId, signal) returns the sentence review of one run of `appId`. Each review(text) call
 * is one Aliyun output review (llm_response_moderation, the same ACS3-signed adapter and verdict
 * mapping as createStreamReview's review) bounded by agent.safety.timeout_ms of that app:
 * - read through deps.config for this run (never at build; a later change applies to the next
 *   run); a missing key is the BR-AI-18 default 1000 ms (options.timeoutMs stands in for that
 *   default when set); a value that is not a finite positive number takes the same default;
 * - one deadline per review call, counted from the call: the wait for the configuration read is
 *   inside it (a 300 ms budget read in 200 ms leaves 100 ms for the request; a read slower than
 *   its own value answers 'timeout' as soon as the value is known), never read time plus budget;
 * - a read that fails, does not settle within the default, or outlives `signal` answers 'timeout'
 *   (fail-close), as does a request that does not finish within the deadline.
 * Without live settings (no options, local / test, a missing or blank credential half, no https
 * endpoint) every review answers 'timeout' at once with no network request. Building performs no
 * external work; credentials and review text are never logged.
 */
export function createStreamOutputReview(deps: StreamReviewDeps): RunSentenceReviewPort {
  void deps;
  throw new Error('NotImplemented: createStreamOutputReview');
}
