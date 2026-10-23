// B3-09e (BR-AI-22, D10-175 取 B): Agent data purge on account deletion. The deletion cleanup
// transaction (B1-15g) calls purgeAgentDataForUser(trx, { appId, userId, at }) on its own
// transaction; this port never opens, commits or rolls back one, holds no pool and reads no env.
//
// Rows are never deleted (no DELETE is granted): free text is cleared to the exact empty values the
// 0073 / 0070 guards admit, in one statement per table (the guards accept no intermediate state):
//   1. SELECT … ORDER BY id FOR NO KEY UPDATE of the user's sessions (app_id + user_id): row locks in
//      id order, so a concurrent cleanup of the same user waits and then finds nothing.
//   2. agent_runs of those sessions: user_text → NULL; quota_subjects member tuple of this user →
//      the same tuple with the user hash; final_event / end_draft: data.msg and data.fallback_q →
//      JSON null where present (no key added, every other key kept); row_version + 1, updated_at
//      untouched (only sessions take `at`).
//   3. agent_messages of those sessions (by session, not by run: assistant rows may have no run):
//      text, report_reason, report_note → NULL; row_version + 1.
//   4. agent_tool_calls.args → SQL NULL; agent_cards.data → '{}' and fallback_text → the placeholder;
//      agent_result_sets.conditions and agent_result_deliveries.card → '{}';
//      agent_result_chains.conditions (when set) → {"chain_id": <the row's chain_id>}.
//   5. agent_sessions: user_id → NULL with user_hash = HMAC-SHA256(key, userId) in the same UPDATE,
//      updated_at = at, row_version + 1.
// Kept as the network-log minimum: run id / times / finish_reason / session_id, session device_id /
// started_at, tool names, card link_id. agent_clarify_asks holds no free text and is not touched.
// Re-entrant: once detached no session has user_id = userId → { sessions: 0, messages: 0 } and
// nothing is written. Every argument is validated before the first statement.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import { createHmac } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type RawBuilder, type Transaction } from 'kysely';

export interface PurgeAgentDataInput {
  appId: string;
  userId: string;
  at: Date;
}

export interface PurgeAgentDataResult {
  sessions: number;
  messages: number;
}

export interface AgentDataPurge {
  purgeAgentDataForUser(
    trx: Transaction<DB>,
    input: PurgeAgentDataInput,
  ): Promise<PurgeAgentDataResult>;
}

/** The environment variable that carries the agent user hash key (kept apart from the phone HMAC). */
const KEY_ENV = 'AGENT_USER_HASH_KEY';
/** agent_cards.fallback_text placeholder admitted by the 0073 guard. */
const PURGED_CARD_TEXT = '内容已删除';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function agentUserHash(key: string, userId: string): string {
  if (!nonBlank(key)) throw new TypeError('agent: the user hash key must not be blank');
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('agent: the user id to hash must not be empty');
  }
  return createHmac('sha256', Buffer.from(key, 'utf8')).update(userId, 'utf8').digest('hex');
}

export function readAgentUserHashKey(env: Readonly<Record<string, string | undefined>>): string {
  const value = env == null ? undefined : env[KEY_ENV];
  if (!nonBlank(value)) throw new Error(`agent: ${KEY_ENV} is missing or blank`);
  return value;
}

export function purgedCardText(): string {
  return PURGED_CARD_TEXT;
}

function memberSubject(id: string): string {
  return JSON.stringify(['member', id]);
}

/** A terminal envelope with data.msg / data.fallback_q set to JSON null where present. */
function redactedFrame(column: 'final_event' | 'end_draft'): RawBuilder<unknown> {
  const ref = sql.ref(column);
  return sql`CASE WHEN jsonb_typeof(${ref} -> 'data') = 'object' THEN jsonb_set(${ref}, '{data}',
    (${ref} -> 'data')
      || CASE WHEN (${ref} -> 'data') ? 'msg' THEN '{"msg": null}'::jsonb ELSE '{}'::jsonb END
      || CASE WHEN (${ref} -> 'data') ? 'fallback_q' THEN '{"fallback_q": null}'::jsonb
              ELSE '{}'::jsonb END)
    ELSE ${ref} END`;
}

function affected(result: { numAffectedRows?: bigint }): number {
  return Number(result.numAffectedRows ?? 0n);
}

function validInput(input: unknown): { appId: string; userId: string; at: Date } {
  const candidate = input as Partial<PurgeAgentDataInput> | null | undefined;
  if (
    candidate == null ||
    !nonBlank(candidate.appId) ||
    typeof candidate.userId !== 'string' ||
    !UUID.test(candidate.userId) ||
    !(candidate.at instanceof Date) ||
    !Number.isFinite(candidate.at.getTime())
  ) {
    throw new TypeError('agent: purgeAgentDataForUser needs appId, a uuid userId and a valid at');
  }
  return { appId: candidate.appId, userId: candidate.userId.toLowerCase(), at: candidate.at };
}

export function createAgentDataPurge(deps: { userHashKey: string }): AgentDataPurge {
  const key = deps == null ? undefined : deps.userHashKey;
  if (!nonBlank(key)) throw new Error('agent: createAgentDataPurge needs a non-blank userHashKey');
  const hashKey: string = key;

  async function purgeAgentDataForUser(
    trx: Transaction<DB>,
    input: PurgeAgentDataInput,
  ): Promise<PurgeAgentDataResult> {
    const { appId, userId, at } = validInput(input);
    const userHash = agentUserHash(hashKey, userId);

    const locked = await sql<{ id: string }>`SELECT id FROM app.agent_sessions
      WHERE app_id = ${appId} AND user_id = ${userId}
      ORDER BY id FOR NO KEY UPDATE`.execute(trx);
    const sessionIds = locked.rows.map((row) => row.id);
    if (sessionIds.length === 0) return { sessions: 0, messages: 0 };

    const runs = await sql<{ id: string }>`UPDATE app.agent_runs SET
        user_text = NULL,
        quota_subjects = array_replace(quota_subjects, ${memberSubject(userId)}::text,
          ${memberSubject(userHash)}::text),
        final_event = ${redactedFrame('final_event')},
        end_draft = ${redactedFrame('end_draft')},
        row_version = row_version + 1
      WHERE app_id = ${appId} AND session_id = ANY(${sessionIds}::uuid[])
      RETURNING id`.execute(trx);
    const runIds = runs.rows.map((row) => row.id);

    const messages = await sql`UPDATE app.agent_messages SET
        text = NULL, report_reason = NULL, report_note = NULL, row_version = row_version + 1
      WHERE app_id = ${appId} AND session_id = ANY(${sessionIds}::uuid[])`.execute(trx);

    await sql`UPDATE app.agent_tool_calls SET args = NULL
      WHERE app_id = ${appId} AND run_id = ANY(${runIds}::uuid[])
        AND args IS NOT NULL`.execute(trx);

    await sql`UPDATE app.agent_cards SET data = '{}'::jsonb, fallback_text = ${PURGED_CARD_TEXT}
      WHERE app_id = ${appId}
        AND (session_id = ANY(${sessionIds}::uuid[]) OR run_id = ANY(${runIds}::uuid[]))
        AND (data <> '{}'::jsonb OR fallback_text <> ${PURGED_CARD_TEXT})`.execute(trx);

    await sql`UPDATE app.agent_result_sets SET conditions = '{}'::jsonb
      WHERE app_id = ${appId} AND run_id = ANY(${runIds}::uuid[])
        AND conditions <> '{}'::jsonb`.execute(trx);

    await sql`UPDATE app.agent_result_deliveries SET card = '{}'::jsonb
      WHERE app_id = ${appId}
        AND (session_id = ANY(${sessionIds}::uuid[]) OR run_id = ANY(${runIds}::uuid[]))
        AND card <> '{}'::jsonb`.execute(trx);

    await sql`UPDATE app.agent_result_chains SET conditions = jsonb_build_object('chain_id', chain_id)
      WHERE app_id = ${appId} AND session_id = ANY(${sessionIds}::uuid[])
        AND conditions IS NOT NULL
        AND conditions <> jsonb_build_object('chain_id', chain_id)`.execute(trx);

    const sessions = await sql`UPDATE app.agent_sessions SET
        user_id = NULL, user_hash = ${userHash}, updated_at = ${at}, row_version = row_version + 1
      WHERE app_id = ${appId} AND user_id = ${userId}
        AND id = ANY(${sessionIds}::uuid[])`.execute(trx);

    return { sessions: affected(sessions), messages: affected(messages) };
  }

  return { purgeAgentDataForUser };
}
