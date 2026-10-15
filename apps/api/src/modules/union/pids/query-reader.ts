import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** B1-04x: read-only pdd/query/active lookup, without admin verification or audit dependencies. */
export async function readActivePddQueryPid(db: Kysely<DB>, appId: string): Promise<string | null> {
  void db;
  void appId;
  throw new Error('NotImplemented: readActivePddQueryPid');
}
