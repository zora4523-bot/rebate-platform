import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, JobQueue, ReceivedJob, RootLogger } from '../../platform/index.ts';

export interface PageScheduleJobDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly logger: RootLogger;
}

export interface PageScheduleJob {
  handle(job: ReceivedJob): Promise<void>;
}

/** F1-09p: 到期后在页行锁内物化；提前收到时同事务重新入队。 */
export function createPageScheduleJob(deps: PageScheduleJobDeps): PageScheduleJob {
  void deps;
  throw new Error('NotImplemented: createPageScheduleJob');
}
