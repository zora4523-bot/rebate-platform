// B1-12d: GET /v1/messages/{message_id} (contract getMessage) — the push-click lookup (BR-ID-10
// 细则「推送点击的落点」). One inbox_messages row of the caller: the query is scoped by app_id,
// user_id and message_id together; unknown, someone else's, another app's or a message id that is
// not a UUID all answer null (the controller maps null to 30701, not distinguished). Read-only:
// never changes read_at and writes no table.
import type { Schema } from '@couli/contracts-ts';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';

/** The subject comes from the verified token principal only; message_id from the path. */
export interface MessageQuery {
  readonly app_id: string;
  readonly user_id: string;
  readonly message_id: string;
}

/** Contract InboxMessage: created_at / read_at as date-time strings, route {route, params} or null. */
export type InboxMessageView = Schema<'InboxMessage'>;

export interface MessageReader {
  /** The caller's own message, or null (unknown, not the caller's, another app's, not a UUID). */
  get(query: MessageQuery): Promise<InboxMessageView | null>;
}

export interface MessageReaderOptions {
  readonly db: Kysely<Database>;
}

export function createMessageReader(options: MessageReaderOptions): MessageReader {
  void options;
  throw new Error('NotImplemented: createMessageReader');
}
