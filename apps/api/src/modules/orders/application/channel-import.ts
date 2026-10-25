// B1-09h: the kind=channel row processor of the rights_import job (08 BR-ATTR-26 ② and 细则
// 「渠道单导入」; orchestrator ruling D10-152, plan K-5). Rule tests: test/spec/orders/channel-import/**.
// One row is one channel blocklist entry, written through risk's order-side blocklist port
// (createOrderBlocklistPorts().importChannels, B1-09a; declared here by structure, risk's
// implementation satisfies it): orders never writes risk's tables (02 §4.1).
//   - row.values: `relation_id` (required: a text, trimmed of leading / trailing white space before
//     the emptiness check and the write; an integer number cell is its decimal text, any other
//     number is invalid) and `end_at` (optional: empty = in force until stopped; an ISO 8601 text —
//     with Z or an offset as given, without one read at +08:00, never the server's zone — or a
//     Date cell of the sheet);
//   - union_account_id is the task's (rows carry none); start_at (imported_at) = the task's
//     created_at, also when the row is processed later or again; created_by = the task's admin;
//   - outcomes: inserted → succeeded; an effective entry already there (port: duplicate; same app,
//     union account and relation_id, active, end_at empty or later than the import time) →
//     duplicate, nothing inserted; relation_id missing, blank or neither a text nor an integer,
//     end_at unreadable or not after start_at → failed invalid_row; the platform of the task's
//     union account (union's
//     account listing, by app_id and union_account_id) ≠ the task's platform → failed
//     platform_mismatch. A failed row writes nothing;
//   - with the job's transaction (rights-import-ports.ts) every statement runs on it and nothing is
//     committed here: the job hands each row the transaction that also commits the row's
//     checkpoint, so a redelivered row is counted once; without one each row is one transaction of
//     its own;
//   - no scan of stored orders: the entry voids later orders in the pipeline step (B1-09b) only;
//     no audit per row (the upload writes one for the whole file, B1-09g).
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { checkChannelRow } from '../domain/channel-row.ts';
import type { RightsImportRowOutcome } from '../domain/rights-import.ts';
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

const INVALID_ROW: RightsImportRowOutcome = { kind: 'failed', reason: 'invalid_row' };
const PLATFORM_MISMATCH: RightsImportRowOutcome = { kind: 'failed', reason: 'platform_mismatch' };

export function createChannelImportProcessor(deps: ChannelImportDeps): RightsImportRowProcessor {
  const { db, blocklist, accounts } = deps;
  /** The platform of the last task's union account (null: not in union's listing). */
  let known: { readonly key: string; readonly platform: string | null } | undefined;

  async function accountPlatform(appId: string, accountId: string): Promise<string | null> {
    const key = JSON.stringify([appId, accountId]);
    if (known?.key !== key) {
      const listed = await accounts.listEnabledAccounts();
      const account = listed.find((a) => a.app_id === appId && a.union_account_id === accountId);
      known = { key, platform: account?.platform ?? null };
    }
    return known.platform;
  }

  return {
    async process(task, row, trx) {
      const accountId = task.union_account_id;
      if (accountId === null) return INVALID_ROW;
      // An account missing from union's listing (another App's, or unknown) is no account of the
      // task's platform either.
      if ((await accountPlatform(task.app_id, accountId)) !== task.platform) {
        return PLATFORM_MISMATCH;
      }
      const checked = checkChannelRow(row.values, task.created_at);
      if (!checked.ok) return INVALID_ROW;
      const input: ChannelBlocklistImport = {
        app_id: task.app_id,
        platform: task.platform,
        union_account_id: accountId,
        created_by: task.created_by,
        imported_at: task.created_at,
        rows: [{ relation_id: checked.relation_id, end_at: checked.end_at }],
      };
      const results =
        trx === undefined
          ? await db.transaction().execute((own) => blocklist.importChannels(own, input))
          : await blocklist.importChannels(trx, input);
      const status = results[0]?.status;
      if (status === 'inserted') return { kind: 'succeeded' };
      if (status === 'duplicate') return { kind: 'duplicate' };
      throw new Error('orders: channel blocklist import returned no result for the row');
    },
  };
}
