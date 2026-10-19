// dict_items reads of GET /v1/dict (F1-02s). Primary handle; content is dict_items' only writer
// and this store only reads it (and config_items' dict_version).
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import type { DictSnapshot, DictStore } from '../application/dict-reader.ts';

export function createKyselyDictStore(db: Kysely<Database>): DictStore {
  return {
    snapshot: (appId, limitOf) =>
      // REPEATABLE READ fixes the snapshot at the first statement, so the version read here and
      // the rows read below always belong to the same committed state (F1-02s §9.12).
      db
        .transaction()
        .setIsolationLevel('repeatable read')
        .setAccessMode('read only')
        .execute(async (trx): Promise<DictSnapshot> => {
          const app = trx.withSchema('app');
          const config = await app
            .selectFrom('config_items')
            .select('value')
            .where('app_id', '=', appId)
            .where('key', '=', 'dict_version')
            .executeTakeFirst();
          const value: unknown = config?.value;
          const limit = limitOf(value);
          if (limit === null) return { value, rows: [] };
          // The primary key (app_id, dict, code, version) serves both the filter and the order.
          const rows = await app
            .selectFrom('dict_items')
            .distinctOn(['dict', 'code'])
            .select(['dict', 'code', 'text'])
            .where('app_id', '=', appId)
            .where('version', '<=', limit)
            .orderBy('dict')
            .orderBy('code')
            .orderBy('version', 'desc')
            .execute();
          return { value, rows };
        }),
  };
}
