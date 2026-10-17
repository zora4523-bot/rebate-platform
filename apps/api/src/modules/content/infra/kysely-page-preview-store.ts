// page_preview_tokens (written by content only) and the page reads of a preview (F1-09e).
// couli_app may INSERT tokens and UPDATE only used_count (0039_pages.sql); pages and
// page_versions are read here, never written.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { AuditPort } from '../../platform/index.ts';
import type { PagePreviewIssueTx, PagePreviewStore } from '../application/page-preview.ts';

function issueTx(trx: Kysely<DB>, audit: AuditPort): PagePreviewIssueTx {
  const app = trx.withSchema('app');
  return {
    async pageHasVersions(appId, pageKey) {
      const row = await app
        .selectFrom('pages as p')
        .select('p.page_key')
        .where('p.app_id', '=', appId)
        .where('p.page_key', '=', pageKey)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('page_versions as v')
              .select(sql<number>`1`.as('one'))
              .whereRef('v.app_id', '=', 'p.app_id')
              .whereRef('v.page_key', '=', 'p.page_key'),
          ),
        )
        .executeTakeFirst();
      return row !== undefined;
    },

    async versionExists(appId, pageKey, version) {
      const row = await app
        .selectFrom('page_versions')
        .select('version')
        .where('app_id', '=', appId)
        .where('page_key', '=', pageKey)
        .where('version', '=', version)
        .executeTakeFirst();
      return row !== undefined;
    },

    async insertToken(row) {
      // Both instants are bound from the injected Clock (no SQL now() or column default).
      await app
        .insertInto('page_preview_tokens')
        .values({
          token_hash: row.tokenHash,
          app_id: row.appId,
          page_key: row.pageKey,
          version: row.version,
          created_by: row.createdBy,
          created_at: row.createdAt,
          expire_at: row.expireAt,
        })
        .execute();
    },

    audit: (input) => audit.append(input),
  };
}

/**
 * `auditWriter` binds the audit port to a transaction (admin entry); null on the api entry,
 * which only reads previews and never issues a token.
 */
export function createKyselyPagePreviewStore(
  db: Kysely<DB>,
  auditWriter: ((trx: Kysely<DB>) => AuditPort) | null,
): PagePreviewStore {
  // Schema bound per call, so building the store never touches the handle.
  const app = () => db.withSchema('app');
  return {
    transaction: (work) =>
      auditWriter === null
        ? Promise.reject(new Error('content: preview tokens are issued on the admin entry only'))
        : db.transaction().execute((trx) => work(issueTx(trx, auditWriter(trx)))),

    async consume({ appId, pageKey, tokenHash, now }) {
      // Check and count in one statement: no read-then-write window, refusals change nothing.
      const row = await app()
        .updateTable('page_preview_tokens')
        .set((eb) => ({ used_count: eb('used_count', '+', 1) }))
        .where('token_hash', '=', tokenHash)
        .where('page_key', '=', pageKey)
        .where('app_id', '=', appId)
        .where('expire_at', '>', now)
        .returning('version')
        .executeTakeFirst();
      return row?.version;
    },

    async sections(appId, pageKey, version) {
      const row = await app()
        .selectFrom('page_versions')
        .select('sections')
        .where('app_id', '=', appId)
        .where('page_key', '=', pageKey)
        .where('version', '=', version)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      if (!Array.isArray(row.sections)) throw new Error('content: page sections are not a list');
      return row.sections as unknown[];
    },
  };
}
