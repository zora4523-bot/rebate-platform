// F1-07c: the console's binding changes run on one primary-connection transaction, with admin's
// audit writer (the single writer of audit_logs) and content's configuration reader both bound to
// that transaction (app.module passes the factories; linking imports neither module).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { AuditPort } from '../../platform/index.ts';
import type { AdminUnionBindingsStore } from '../application/admin-union-bindings.ts';
import type { LinkingConfigReader } from '../ports.ts';

export function createKyselyAdminUnionBindingsStore(
  db: Kysely<DB>,
  auditWriter: (trx: Kysely<DB>) => AuditPort,
  configReader: (trx: Kysely<DB>) => LinkingConfigReader,
): AdminUnionBindingsStore {
  return {
    transaction: (work) =>
      db.transaction().execute((trx) => work(trx, auditWriter(trx), configReader(trx))),
  };
}
