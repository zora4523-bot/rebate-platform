// Identity's batch deletion-stage reader (task B1-15c §9.2 #1 / §9.3; BR-ID-27, BR-ID-28,
// BR-INV-02). Other modules read a user's account-deletion stage only through this port (0059's
// header: "other modules read through the port identity exports").
//
// One statement on the executor the caller passes (its uncommitted writes are visible): app.users
// left join app.deletion_requests on (app_id, user_id), filtered by app_id and id = ANY(deduplicated
// ids). Only users that exist for this app_id are returned; an empty id list runs no query. The
// `db` option is kept for the agreed signature and never runs a query. No locks (BR-INV-02 judges
// at the call's instant; a request committed after the read is a request later than the read), no
// writes, no logging, no identifying or time columns, no Clock: a cooling request past its window
// that the job has not processed yet still reads cooling.
//
// Each user gets the later of two stages (done > processing > cooling > none, §9.3):
//   - deletion_requests: an open request (cooling / processing, at most one per user by
//     deletion_requests_open_user_key) → its status; else any done request → done; only cancelled
//     requests or none → none;
//   - users.status: deleting → processing (BR-ID-28), deleted → done, anything else → none.
//
// The funds lane's createUserDeletionStatusReader (B1-02ze, users.status only, no cooling) is a
// separate port and is not routed through this one.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';

export type DeletionStage = 'none' | 'cooling' | 'processing' | 'done';

export interface DeletionStageInput {
  appId: string;
  userIds: readonly string[];
}

export interface DeletionStageReader {
  read(
    executor: Kysely<DB> | Transaction<DB>,
    input: DeletionStageInput,
  ): Promise<ReadonlyMap<string, DeletionStage>>;
}

export interface DeletionStageReaderOptions {
  db: Kysely<DB>;
}

const RANK: Readonly<Record<DeletionStage, number>> = {
  none: 0,
  cooling: 1,
  processing: 2,
  done: 3,
};

function later(a: DeletionStage, b: DeletionStage): DeletionStage {
  return RANK[b] > RANK[a] ? b : a;
}

/** BR-ID-28: the users row's own trace of the deletion. */
function userStage(status: string): DeletionStage {
  if (status === 'deleting') return 'processing';
  if (status === 'deleted') return 'done';
  return 'none';
}

interface Folded {
  user: DeletionStage;
  open: DeletionStage | null;
  done: boolean;
}

export function createDeletionStageReader(
  options: DeletionStageReaderOptions,
): DeletionStageReader {
  // Kept for the agreed signature only: queries always run on the caller's executor.
  void options;
  return Object.freeze({
    async read(executor: Kysely<DB> | Transaction<DB>, input: DeletionStageInput) {
      const ids = [...new Set(input.userIds)];
      const result = new Map<string, DeletionStage>();
      if (ids.length === 0) return result;
      const rows = await executor
        .withSchema('app')
        .selectFrom('users')
        .leftJoin('deletion_requests', (join) =>
          join
            .onRef('deletion_requests.user_id', '=', 'users.id')
            .onRef('deletion_requests.app_id', '=', 'users.app_id')
            .on('deletion_requests.status', 'in', ['cooling', 'processing', 'done']),
        )
        .select(['users.id', 'users.status', 'deletion_requests.status as request_status'])
        .where('users.app_id', '=', input.appId)
        .where('users.id', '=', sql<string>`ANY(${ids})`)
        .execute();
      const folded = new Map<string, Folded>();
      for (const row of rows) {
        let entry = folded.get(row.id);
        if (entry === undefined) {
          entry = { user: userStage(row.status), open: null, done: false };
          folded.set(row.id, entry);
        }
        const request = row.request_status;
        if (request === 'cooling' || request === 'processing') {
          entry.open = entry.open === null ? request : later(entry.open, request);
        } else if (request === 'done') {
          entry.done = true;
        }
      }
      for (const [id, entry] of folded) {
        // An open request outranks an earlier finished one (a new application after a done one).
        const requestStage: DeletionStage = entry.open ?? (entry.done ? 'done' : 'none');
        result.set(id, later(requestStage, entry.user));
      }
      return result;
    },
  });
}
