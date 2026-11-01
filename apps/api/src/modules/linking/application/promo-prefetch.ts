// B1-06zd (D10-510): the asynchronous prefetch of our Taobao promotion link for self-buy and Agent
// links registered by a product detail. Rule tests: test/spec/linking/promo-url/**.
// Skeleton: every function throws until the implementation stage.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, JobHandler } from '../../platform/index.ts';
import type { UnionRegistry } from '../../union/index.ts';

/** The job name of one prefetch. */
export type PromoPrefetchJobName = 'linking.promo_prefetch';

/**
 * The queue prefetch jobs run on. pool-refresh is reused: test/spec/platform/queue/** pins the
 * catalog queue by queue, so a new queue cannot be added without changing those frozen tests.
 */
export type PromoPrefetchQueueName = 'pool-refresh';

/** The job carries only where the link is: identity is read from its row, never from the job. */
export interface PromoPrefetchPayload {
  readonly app_id: string;
  readonly link_id: string;
}

/** What decides whether a registered link gets a prefetch job. */
export interface PromoPrefetchCandidate {
  readonly platform: string;
  /** links.entry_source as registered. */
  readonly entrySource: string | null;
  /** links.user_id: null for a guest card. */
  readonly userId: string | null;
  /** The card's rebate basis (catalog's RebateQuote.rebateBasis). */
  readonly rebateBasis: string;
  /** identity_snapshot.relation_id of the registered link. */
  readonly relationId: string | null;
}

export interface PromoPrefetchHandlerOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly registry: Pick<UnionRegistry, 'get'>;
  readonly logger: { warn(fields: Readonly<Record<string, unknown>>, message: string): void };
}

/** Whether a registered link gets a prefetch job (the switch and the rate are read apart). */
export function promoPrefetchEligible(candidate: PromoPrefetchCandidate): boolean {
  void candidate;
  throw new Error('NotImplemented: promoPrefetchEligible');
}

/** convert.taobao_prefetch.rate_per_min as read from configuration: absent or invalid → 60. */
export function promoPrefetchRatePerMin(value: unknown): number {
  void value;
  throw new Error('NotImplemented: promoPrefetchRatePerMin');
}

/** The worker's handler of one prefetch job. */
export function createPromoPrefetchHandler(options: PromoPrefetchHandlerOptions): JobHandler {
  void options;
  throw new Error('NotImplemented: createPromoPrefetchHandler');
}
