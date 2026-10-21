// B1-12k: the caller's inbox (BR-ID-10 细则「推送点击的落点」: only the logged-in account's
// messages). Contract listMessages / markMessagesRead / getUnreadMessageCount.
//
// - Every statement is scoped by app_id and user_id of the verified principal.
// - list: keyset pagination on (created_at, message_id), both descending, over the index
//   inbox_messages_user_created_idx. The cursor keeps created_at with microseconds (PG text, never
//   a JS Date) and is bound to the account; a malformed, truncated or foreign cursor is an
//   InboxCursorError (the controller answers 20001 fields [cursor]). Listing writes nothing.
// - markRead: one conditional UPDATE (read_at IS NULL) counts the rows this call turned read, so
//   concurrent calls never count a message twice; a message already read keeps its read_at.
//   Unknown, someone else's and non-UUID ids are skipped silently. The remaining unread count is
//   read in the same transaction.
import { createHash } from 'node:crypto';
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { FixedClock, type Clock } from '../../platform/index.ts';

/** B1-12k: identity is supplied by the verified principal, never the request body. */
export interface InboxOwner {
  readonly app_id: string;
  readonly user_id: string;
}

export interface InboxListQuery extends InboxOwner {
  readonly cursor?: string;
  readonly limit?: number;
}

export type InboxReadCommand = InboxOwner & Schema<'MarkMessagesReadRequest'>;

export interface InboxMessages {
  list(query: InboxListQuery): Promise<Schema<'InboxMessageListData'>>;
  markRead(command: InboxReadCommand): Promise<Schema<'MarkMessagesReadData'>>;
  unreadCount(owner: InboxOwner): Promise<Schema<'UnreadMessageCountData'>>;
}

export interface InboxMessagesOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}

/** The cursor is not one this account received from listMessages (→ 20001 fields [cursor]). */
export class InboxCursorError extends Error {
  readonly fields: readonly string[] = ['cursor'];

  constructor() {
    super('Invalid inbox cursor');
    this.name = 'InboxCursorError';
  }
}

type InboxMessage = Schema<'InboxMessage'>;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const CURSOR_VERSION = 'inbox.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

interface CursorKey {
  /** created_at in UTC with microseconds, e.g. 2026-10-03T01:30:00.123456Z. */
  readonly createdAt: string;
  readonly messageId: string;
}

/** Binds a cursor to one account; not a secret, the query is scoped to the caller anyway. */
function ownerTag(owner: InboxOwner): string {
  return createHash('sha256')
    .update(`${owner.app_id}\u0000${owner.user_id}`)
    .digest('base64url')
    .slice(0, 22);
}

function encodeCursor(owner: InboxOwner, key: CursorKey): string {
  return Buffer.from(
    JSON.stringify([CURSOR_VERSION, key.createdAt, key.messageId, ownerTag(owner)]),
  ).toString('base64url');
}

/** null for anything that is not a cursor encodeCursor gave this account; never throws. */
function decodeCursor(owner: InboxOwner, value: string): CursorKey | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [version, createdAt, messageId, tag] = parsed as unknown[];
    if (
      version !== CURSOR_VERSION ||
      typeof createdAt !== 'string' ||
      !INSTANT.test(createdAt) ||
      typeof messageId !== 'string' ||
      !UUID.test(messageId) ||
      tag !== ownerTag(owner)
    ) {
      return null;
    }
    // A real calendar instant (no month 13): parse the millisecond part through the clock module.
    const millis = `${createdAt.slice(0, 23)}Z`;
    if (new FixedClock(millis).now().toISOString() !== millis) return null;
    const key = { createdAt, messageId };
    return encodeCursor(owner, key) === value ? key : null;
  } catch {
    return null;
  }
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  // The route schema already enforces 1–50; clamp for direct callers.
  if (!Number.isInteger(limit) || limit < 1) return 1;
  return Math.min(limit, MAX_LIMIT);
}

export function createInboxMessages(options: InboxMessagesOptions): InboxMessages {
  const db = options.db.withSchema('app');
  const clock = options.clock;

  const countUnread = async (handle: Kysely<DB>, owner: InboxOwner): Promise<number> => {
    const row = await handle
      .withSchema('app')
      .selectFrom('inbox_messages')
      .select(sql<number>`count(*)::int`.as('unread'))
      .where('app_id', '=', owner.app_id)
      .where('user_id', '=', owner.user_id)
      .where('read_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.unread);
  };

  return {
    async list(query) {
      const owner = { app_id: query.app_id, user_id: query.user_id };
      let after: CursorKey | null = null;
      if (query.cursor !== undefined) {
        after = decodeCursor(owner, query.cursor);
        if (after === null) throw new InboxCursorError();
      }
      const size = pageSize(query.limit);
      let select = db
        .selectFrom('inbox_messages')
        .select([
          'message_id',
          'code',
          'title',
          'body',
          'created_at',
          'read_at',
          'route',
          sql<string>`to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
            'created_key',
          ),
        ])
        .where('app_id', '=', owner.app_id)
        .where('user_id', '=', owner.user_id);
      if (after !== null) {
        select = select.where(
          sql<boolean>`(created_at, message_id) < (${after.createdAt}::timestamptz, ${after.messageId}::uuid)`,
        );
      }
      const rows = await select
        .orderBy('created_at', 'desc')
        .orderBy('message_id', 'desc')
        .limit(size + 1)
        .execute();
      const page = rows.slice(0, size);
      const last = page.at(-1);
      const items: InboxMessage[] = page.map((row) => ({
        message_id: row.message_id,
        code: row.code,
        title: row.title,
        body: row.body,
        created_at: row.created_at.toISOString(),
        read_at: row.read_at?.toISOString() ?? null,
        // RouteTarget is checked when saved (same as getMessage).
        route: row.route as InboxMessage['route'],
      }));
      return {
        items,
        next_cursor:
          rows.length > size && last !== undefined
            ? encodeCursor(owner, { createdAt: last.created_key, messageId: last.message_id })
            : null,
      };
    },

    async markRead(command) {
      const owner = { app_id: command.app_id, user_id: command.user_id };
      const all = 'all' in command && command.all === true;
      const ids =
        'message_ids' in command && Array.isArray(command.message_ids)
          ? [...new Set(command.message_ids.filter((id) => UUID.test(id)))]
          : [];
      if (!all && ids.length === 0) {
        return { marked_count: 0, unread_count: await countUnread(options.db, owner) };
      }
      const now = clock.now();
      return options.db.transaction().execute(async (trx) => {
        let update = trx
          .withSchema('app')
          .updateTable('inbox_messages')
          .set({
            read_at: now,
            updated_at: now,
            row_version: sql<number>`row_version + 1`,
          })
          .where('app_id', '=', owner.app_id)
          .where('user_id', '=', owner.user_id)
          .where('read_at', 'is', null);
        if (!all) update = update.where('message_id', 'in', ids);
        const marked = await update.returning('message_id').execute();
        return { marked_count: marked.length, unread_count: await countUnread(trx, owner) };
      });
    },

    async unreadCount(owner) {
      return { unread_count: await countUnread(options.db, owner) };
    },
  };
}
