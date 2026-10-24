// The Agent conversations section of a personal information copy (规划/08 BR-ID-40 细则「导出范围（默认）」
// 「未过期的 Agent 对话」, BR-ID-30 ①; task B1-27f), for identity's PersonalDataCopySources (assembled
// by app.module).
// createPersonalDataCopyAgentReader({ clock })(handle, subject) — the user's sessions in the app
// (agent_sessions.user_id = the user; a guest session of the same device, user_id NULL, is not the
// user's) that are not yet past the retention of BR-ID-30 ① (190 days, agent.trace.retention_days
// default) at clock.now(), each with its messages oldest first (role, text, created_at). A session
// that BR-AI-20 calls expired (24 hours idle, or expired_at passed) is still within the retention
// and is included. Nothing of the console's report handling (handler, note) or of another person.
// Plain SELECTs on the caller's handle (a READ ONLY transaction included): no locking clause, no
// writes, no logging; time only from options.clock.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface PersonalDataCopyAgentSubject {
  readonly appId: string;
  readonly userId: string;
}

export interface PersonalDataCopyAgentMessageRow {
  readonly role: 'user' | 'assistant';
  readonly text: string | null;
  readonly created_at: Date;
}

export interface PersonalDataCopyAgentConversationRow {
  readonly session_id: string;
  readonly started_at: Date;
  readonly last_active_at: Date;
  readonly messages: readonly PersonalDataCopyAgentMessageRow[];
}

export type PersonalDataCopyAgentRead = (
  handle: Kysely<DB>,
  subject: PersonalDataCopyAgentSubject,
) => Promise<readonly PersonalDataCopyAgentConversationRow[]>;

export interface PersonalDataCopyAgentOptions {
  readonly clock: Clock;
}

export function createPersonalDataCopyAgentReader(
  options: PersonalDataCopyAgentOptions,
): PersonalDataCopyAgentRead {
  void options;
  throw new Error('NotImplemented: createPersonalDataCopyAgentReader');
}
