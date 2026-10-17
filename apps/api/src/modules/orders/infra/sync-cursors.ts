import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { SyncCursorStore } from '../application/sync-ports.ts';

export function createSyncCursorStore(db: Kysely<DB>, clock: Clock): SyncCursorStore {
  void db;
  void clock;
  throw new Error('NotImplemented: createSyncCursorStore');
}
