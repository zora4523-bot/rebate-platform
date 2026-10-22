import type { AppEnv, Clock, RootLogger, Scheduler } from '../../../platform/index.ts';
import type { SentenceReviewPort } from '../../guard/index.ts';
import type { AliyunCredentials, AliyunReviewFetch } from '../../guard/review/index.ts';
import type { AgentRunTexts, InputCheckPort } from '../../orchestrator/index.ts';

/** Composition-root configuration, never process.env in agent code. Omitted configuration,
 * incomplete credentials or a local/test environment must fail closed without network I/O.
 * Production defaults for fetch/nonce are supplied by the implementation; tests inject both.
 */
export interface StreamReviewOptions {
  readonly appEnv: AppEnv;
  readonly credentials?: AliyunCredentials | undefined;
  readonly endpoint?: string | undefined;
  readonly timeoutMs?: number;
  readonly fetch?: AliyunReviewFetch;
  readonly nonce?: () => string;
}

export interface StreamReviewPorts {
  readonly inputCheck: InputCheckPort;
  readonly review: SentenceReviewPort;
}

/** Connects B3-05d input checking and B3-06b sentence review, with real ACS3 signing.
 * Default safety budget is 1000ms. Construction performs no external work.
 */
export function createStreamReview(deps: {
  readonly options?: StreamReviewOptions;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly logger: RootLogger;
  readonly texts: Pick<AgentRunTexts, 'text'>;
}): StreamReviewPorts {
  void deps;
  throw new Error('NotImplemented: createStreamReview');
}
