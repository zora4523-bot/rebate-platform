// Scheduled page publish due jobs of the worker entry (F1-09p, 编排者裁定 9.2 #6): app.module
// imports this module on `worker` only. It registers the page-schedule handler (jobs/page-schedule.ts)
// on JOB_QUEUE for queue `page-schedule` (in the worker's ENTRY_PLAN only). Without a database
// handle or a queue nothing is registered and one info line `page_schedule_disabled` is logged.
//
// A class decorator only (no parameter decorators or parameter properties; dependencies are
// injected through a factory), as in risk/risk-scan.module.ts.
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  CLOCK,
  DB,
  JOB_QUEUE,
  ROOT_LOGGER,
  type Clock,
  type QueueRuntime,
  type RootLogger,
} from '../platform/index.ts';
import { createPageScheduleJob, type PageScheduleJob } from './jobs/page-schedule.ts';
import { PAGE_SCHEDULE_QUEUE } from './infra/kysely-page-config-store.ts';

/** Provider token of the registered handler (null when disabled). */
export const PAGE_SCHEDULE_JOB_HANDLER = Symbol('PAGE_SCHEDULE_JOB_HANDLER');

/** F1-09p: 仅由 worker 入口装配定时发布任务处理器。 */
@Module({})
export class ContentWorkerModule {
  static forWorker(): DynamicModule {
    return {
      module: ContentWorkerModule,
      providers: [
        {
          provide: PAGE_SCHEDULE_JOB_HANDLER,
          inject: [
            CLOCK,
            ROOT_LOGGER,
            { token: DB, optional: true },
            { token: JOB_QUEUE, optional: true },
          ],
          useFactory: (
            clock: Clock,
            logger: RootLogger,
            db?: Kysely<Database>,
            queue?: QueueRuntime,
          ): PageScheduleJob | null => {
            if (db === undefined || queue === undefined) {
              logger.info({ queue: PAGE_SCHEDULE_QUEUE }, 'page_schedule_disabled');
              return null;
            }
            const job = createPageScheduleJob({ db, clock, queue, logger });
            queue.register(PAGE_SCHEDULE_QUEUE, (received) => job.handle(received));
            return job;
          },
        },
      ],
      exports: [PAGE_SCHEDULE_JOB_HANDLER],
    };
  }
}
