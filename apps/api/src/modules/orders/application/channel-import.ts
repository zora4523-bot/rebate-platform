// B1-09h: the kind=channel row processor of the rights_import job (08 BR-ATTR-26 ② and 细则
// 「渠道单导入」; orchestrator ruling D10-152, plan K-5). Rule tests: test/spec/orders/channel-import/**.
// One row is one channel blocklist entry, written through risk's order-side blocklist port
// (createOrderBlocklistPorts().importChannels, B1-09a; declared here by structure, risk's
// implementation satisfies it): orders never writes risk's tables (02 §4.1).
//   - row.values: `relation_id` (required, a non-empty text) and `end_at` (optional: empty = in
//     force until stopped; an ISO 8601 instant with offset, or a Date cell of the sheet);
//   - union_account_id is the task's (rows carry none); start_at (imported_at) = the task's
//     created_at, also when the row is processed later or again; created_by = the task's admin;
//   - outcomes: inserted → succeeded; an effective entry already there (port: duplicate; same app,
//     union account and relation_id, active, end_at empty or later than the import time) →
//     duplicate, nothing inserted; relation_id missing or not a text, end_at unreadable or not
//     after start_at → failed invalid_row; the platform of the task's union account (union's
//     account listing, by app_id and union_account_id) ≠ the task's platform → failed
//     platform_mismatch. A failed row writes nothing;
//   - with the job's transaction (rights-import-ports.ts) every statement runs on it and nothing is
//     committed here; without one each row is one transaction of its own;
//   - no scan of stored orders: the entry voids later orders in the pipeline step (B1-09b) only;
//     no audit per row (the upload writes one for the whole file, B1-09g).
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { RightsImportRowProcessor } from './rights-import-ports.ts';
import type { SyncAccessPort } from './sync-ports.ts';

/** risk's ChannelBlocklistImport (B1-09a). */
export interface ChannelBlocklistImport {
  readonly app_id: string;
  readonly platform: string;
  readonly union_account_id: string;
  readonly created_by: string;
  /** rights_imports.created_at: every entry's start_at. */
  readonly imported_at: Date;
  readonly rows: readonly {
    readonly relation_id: string;
    readonly end_at: Date | null;
  }[];
}

/** risk's ChannelBlocklistImportResult (B1-09a). */
export interface ChannelBlocklistImportResult {
  readonly status: 'inserted' | 'duplicate';
  readonly blocklist_id: string;
}

/** The one item of risk's order-side blocklist ports this processor uses; runs on the caller's trx. */
export interface ChannelBlocklistPort {
  importChannels(
    trx: Transaction<DB>,
    input: ChannelBlocklistImport,
  ): Promise<readonly ChannelBlocklistImportResult[]>;
}

export interface ChannelImportDeps {
  /** Opens the row's transaction when the job hands none. */
  readonly db: Kysely<DB>;
  readonly blocklist: ChannelBlocklistPort;
  /** union's account listing (createUnionSyncAccess): the platform of the task's union account. */
  readonly accounts: Pick<SyncAccessPort, 'listEnabledAccounts'>;
}

export function createChannelImportProcessor(deps: ChannelImportDeps): RightsImportRowProcessor {
  void deps;
  throw new Error('NotImplemented: createChannelImportProcessor');
}
