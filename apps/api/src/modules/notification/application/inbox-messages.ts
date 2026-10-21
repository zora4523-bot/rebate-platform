import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

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

/** Contract listMessages / markMessagesRead / getUnreadMessageCount. */
export function createInboxMessages(options: InboxMessagesOptions): InboxMessages {
  void options;
  throw new Error('NotImplemented: createInboxMessages');
}
