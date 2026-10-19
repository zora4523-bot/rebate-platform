// dict_items reads and writes for the admin dictionary editor (F1-02t). content is the single
// writer of dict_items and of config_items `dict_version`; the audit row goes through admin's
// writer bound to the same transaction. Primary connection only.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { AuditPort } from '../../platform/index.ts';
import {
  DictConflictError,
  type DictEffective,
  type DictItemStore,
  type DictReadTx,
  type DictWriteTx,
} from '../application/dict-item-admin.ts';
import { joinDictKey, splitDictKey } from '../domain/dict/index.ts';

const DICT_VERSION_KEY = 'dict_version';
/** Unique keys whose violation means a concurrent publish won the same version. */
const VERSION_CONSTRAINTS = new Set(['config_items_pkey', 'dict_items_pkey']);

function readTx(trx: Kysely<DB>): DictReadTx {
  const app = trx.withSchema('app');
  return {
    dictVersion: (appId) =>
      app
        .selectFrom('config_items')
        .select(['value', 'version'])
        .where('app_id', '=', appId)
        .where('key', '=', DICT_VERSION_KEY)
        .executeTakeFirst(),

    async effective(appId, atVersion, keys) {
      const found = new Map<string, DictEffective>();
      if (atVersion <= 0 || (keys !== undefined && keys.length === 0)) return found;
      const pairs = keys?.map(splitDictKey);
      const rows = await app
        .selectFrom('dict_items')
        .distinctOn(['dict', 'code'])
        .select(['dict', 'code', 'version', 'text'])
        .where('app_id', '=', appId)
        .where('version', '<=', atVersion)
        .$if(pairs !== undefined, (query) =>
          query.where((eb) =>
            eb.or(
              (pairs ?? []).map((pair) =>
                eb.and([eb('dict', '=', pair.dict), eb('code', '=', pair.code)]),
              ),
            ),
          ),
        )
        .orderBy('dict')
        .orderBy('code')
        .orderBy('version', 'desc')
        .execute();
      for (const row of rows) {
        found.set(joinDictKey(row.dict, row.code), { text: row.text, version: row.version });
      }
      return found;
    },
  };
}

function writeTx(trx: Kysely<DB>, audit: AuditPort): DictWriteTx {
  const app = trx.withSchema('app');
  return {
    ...readTx(trx),

    lockVersion: (appId) =>
      app
        .selectFrom('config_items')
        .select(['value', 'version'])
        .where('app_id', '=', appId)
        .where('key', '=', DICT_VERSION_KEY)
        .forUpdate()
        .executeTakeFirst(),

    async publish(input) {
      const value = sql<DB['config_items']['value']>`${JSON.stringify(input.value)}::jsonb`;
      const appId = input.actor.appId;
      let version: number;
      if (input.previous === undefined) {
        // No row to lock: a concurrent first publish fails on the primary key (→ 20902).
        await app
          .insertInto('config_items')
          .values({
            app_id: appId,
            key: DICT_VERSION_KEY,
            value,
            version: 1,
            row_version: 0,
            updated_by: input.actor.loginName,
            created_at: input.at,
            updated_at: input.at,
          })
          .execute();
        version = 1;
      } else {
        const row = await app
          .updateTable('config_items')
          .set((eb) => ({
            value,
            version: eb('version', '+', 1),
            row_version: eb('row_version', '+', 1),
            updated_by: input.actor.loginName,
            updated_at: input.at,
          }))
          .where('app_id', '=', appId)
          .where('key', '=', DICT_VERSION_KEY)
          .where('version', '=', input.previous.version)
          .returning('version')
          .executeTakeFirst();
        // Locked FOR UPDATE above, so this only guards against a broken lock.
        if (row === undefined) throw new DictConflictError();
        version = row.version;
      }
      await app
        .insertInto('config_item_versions')
        .values({
          app_id: appId,
          key: DICT_VERSION_KEY,
          version,
          value,
          updated_by: input.actor.loginName,
          updated_by_admin_id: input.actor.adminId,
          reason: null,
          created_at: input.at,
        })
        .execute();
    },

    async insertItems(rows) {
      if (rows.length === 0) return;
      await app
        .insertInto('dict_items')
        .values(
          rows.map((row) => ({
            app_id: row.appId,
            ...splitDictKey(row.key),
            version: row.version,
            text: row.text,
            created_by: row.createdBy,
            created_at: row.at,
          })),
        )
        .execute();
    },

    audit: (input) => audit.append(input),
  };
}

function isVersionConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === '23505' && typeof constraint === 'string' && VERSION_CONSTRAINTS.has(constraint);
}

export function createKyselyDictItemStore(
  db: Kysely<DB>,
  auditWriter: (trx: Kysely<DB>) => AuditPort,
): DictItemStore {
  return {
    read: (work) =>
      db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute((trx) => work(readTx(trx))),

    history(appId, key, page, pageSize) {
      // Count and page must describe the same snapshot during concurrent writes.
      return db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => {
          const pair = key === null ? null : splitDictKey(key);
          const query = trx
            .withSchema('app')
            .selectFrom('dict_items')
            .where('app_id', '=', appId)
            .$if(pair !== null, (q) =>
              q.where('dict', '=', pair!.dict).where('code', '=', pair!.code),
            );
          const count = await query
            .select((eb) => eb.fn.countAll<string | number | bigint>().as('total'))
            .executeTakeFirstOrThrow();
          const rows = await query
            .select(['dict', 'code', 'version', 'text', 'created_by', 'created_at'])
            .orderBy('version', 'desc')
            // Byte order, so the key order does not depend on the database collation.
            .orderBy(sql`dict collate "C"`)
            .orderBy(sql`code collate "C"`)
            .offset((page - 1) * pageSize)
            .limit(pageSize)
            .execute();
          return {
            items: rows.map((row) => ({
              key: joinDictKey(row.dict, row.code),
              version: row.version,
              text: row.text,
              created_by: row.created_by,
              created_at: row.created_at.toISOString(),
            })),
            page,
            page_size: pageSize,
            total: Number(count.total),
          };
        });
    },

    async transaction(work) {
      try {
        return await db.transaction().execute((trx) => work(writeTx(trx, auditWriter(trx))));
      } catch (error) {
        if (isVersionConflict(error)) throw new DictConflictError();
        throw error;
      }
    },

    appendAudit: (input) => auditWriter(db).append(input),
  };
}
