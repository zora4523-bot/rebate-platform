// B1-05r: queue pool-refresh on the worker entry (app.module imports this module there only). Like
// SettlementModule.forWorker it registers the handler on JOB_QUEUE and runs the seed on its own
// timer; without a database or a queue nothing is registered and no timer runs.
import type { DB as Database } from '@couli/db';
import type { DynamicModule } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Clock } from '../platform/index.ts';
import type { CatalogConfigReader } from './ports.ts';

export interface CatalogWorkerOptions {
  /** Provides and exports GovernedUnion, assembled by app.module as for CatalogAdminModule. */
  readonly ports: DynamicModule;
  /** content's configuration reader on the worker's handle. */
  readonly config: (db: Kysely<Database>, clock: Clock) => CatalogConfigReader;
}

export class CatalogWorkerModule {
  static forWorker(options: CatalogWorkerOptions): DynamicModule {
    void options;
    throw new Error('NotImplemented: CatalogWorkerModule.forWorker');
  }
}
