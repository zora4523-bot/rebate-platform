import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { PlatformIconStore } from '../application/platform-icon-reader.ts';

/** Primary couli_app handle; tenant-scoped SELECTs in schema app. */
export function createKyselyPlatformIconStore(db: Kysely<DB>): PlatformIconStore {
  void db;
  throw new Error('NotImplemented: createKyselyPlatformIconStore');
}
