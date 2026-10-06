// This infrastructure tool has no workspace package. Resolve the already pinned database
// tooling dependencies from their owning package, without installing anything at runtime.
import { createRequire } from 'node:module';
import type * as Pg from '../../../packages/db/node_modules/@types/pg/index.d.ts';
import type * as Boss from '../../../packages/db/node_modules/pg-boss/dist/index.d.ts';

const requireDb = createRequire(new URL('../../../packages/db/package.json', import.meta.url));
export const { Pool } = requireDb('pg') as typeof Pg;
export const { PgBoss } = requireDb('pg-boss') as typeof Boss;
export type { Pool as SqlPool } from '../../../packages/db/node_modules/@types/pg/index.d.ts';

export const QUEUE = 'qa05b.drill';

export function pool(connectionString: string, applicationName: string, max = 3) {
  const result = new Pool({
    connectionString,
    application_name: applicationName,
    max,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
  });
  // pg emits an error when an idle client is terminated by the drill. Discarding that client
  // lets the next checkout reconnect; operations themselves still reject on query failures.
  result.on('error', () => undefined);
  return result;
}

export function boss(connectionString: string, applicationName: string, supervise: boolean) {
  const result = new PgBoss({
    connectionString,
    application_name: applicationName,
    schema: 'pgboss',
    migrate: false,
    supervise,
    superviseIntervalSeconds: 1,
    schedule: false,
    reindex: false,
    persistQueueStats: false,
    useListenNotify: false,
    connectionTimeoutMillis: 5_000,
    options: '-c statement_timeout=10000',
    max: 3,
  });
  result.on('error', () => undefined);
  return result;
}
