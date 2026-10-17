import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** Linking-owned read port for the shared order projection (HTTP and B3-08). */
export interface OrderLinkProducts {
  productKeys(
    appId: string,
    linkIds: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>>;
}

export function createOrderLinkReader(db: Kysely<DB>): OrderLinkProducts {
  void db;
  throw new Error('NotImplemented: createOrderLinkReader');
}
