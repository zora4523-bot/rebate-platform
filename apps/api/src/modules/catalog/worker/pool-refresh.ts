// B1-05r (BR-PRICE-11, BR-PROD-05, BR-PROD-07, F-ADM-10): queue pool-refresh of the worker entry,
// written as settlement/worker/schedule.ts. One round every pool.refresh_interval_sec per app; the
// union is asked once per (app_id, product_key) on the quota purpose pool_refresh and the answer is
// written back to every online row of that key. The seed decides from the database and pgboss.job
// only, never from process memory, and the queue is `standard`: a singletonKey alone dedups nothing
// there. Job names, payloads and fan-out are the implementer's; the rule tests only run the seed and
// then whatever it queued through the handler.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, JobHandler, JobQueue } from '../../platform/index.ts';
import type { Catalog } from '../domain/types.ts';
import type { CatalogConfigReader, GovernedUnion } from '../ports.ts';

/** pino's two-argument shape. */
export interface PoolRefreshLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}

export interface PoolRefreshOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly logger: PoolRefreshLogger;
  readonly config: Pick<CatalogConfigReader, 'configValue'>;
  readonly catalog: Pick<
    Catalog,
    'listPlatforms' | 'resolveProductKey' | 'readProductRef' | 'takeRawItemId'
  >;
  readonly union: GovernedUnion;
  /** BR-PROD-07 主动失效 of the detail cache. */
  readonly dropDetailCache: (appId: string, productKey: string) => Promise<void>;
}

/** Sends the jobs of the round that is due; a round already queued, running or done sends none. */
export function seedPoolRefresh(options: PoolRefreshOptions): Promise<void> {
  void options;
  throw new Error('NotImplemented: seedPoolRefresh');
}

/** The handler of queue pool-refresh. */
export function createPoolRefreshJobHandler(options: PoolRefreshOptions): JobHandler {
  void options;
  throw new Error('NotImplemented: createPoolRefreshJobHandler');
}
