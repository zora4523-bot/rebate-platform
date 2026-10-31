// B1-05r: PoolReader over product_pools and pool_items (read only; catalog stays their single
// writer through infra/kysely-pool-admin-store.ts and worker/pool-refresh.ts).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { PoolReader } from '../application/pool-read.ts';
import type { CatalogConfigReader } from '../ports.ts';

export interface KyselyPoolReaderOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly config: Pick<CatalogConfigReader, 'configValue'>;
}

export function createKyselyPoolReader(options: KyselyPoolReaderOptions): PoolReader {
  void options;
  throw new Error('NotImplemented: createKyselyPoolReader');
}
