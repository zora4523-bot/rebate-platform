// B3-09e (BR-AI-22, D10-175 取 B): rows stay, free text is cleared to the prescribed empty values,
// the member id becomes the irreversible user hash. Allowed rewrites: 0073 / 0070 file headers.
import { createTestDatabase } from '@couli/db/testing';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { purgedCardText } from '../../../../apps/api/src/modules/agent/deletion/index.ts';
import {
  APP,
  AT,
  KEY,
  OTHER_KEY,
  PLACEHOLDER,
  SEEDED,
  TABLES,
  databaseKit,
  doneFrame,
  expectedHash,
  memberSubject,
  omit,
  type Row,
  type Table,
} from './kit.ts';

const h = databaseKit(createTestDatabase);

function frameData(frame: unknown): Row {
  expect(frame).toBeTypeOf('object');
  expect(frame).not.toBeNull();
  const data = (frame as { data?: unknown }).data;
  expect(data).toBeTypeOf('object');
  return data as Row;
}

/** What BR-AI-22 leaves of a terminal envelope: msg / fallback_q (when present) become JSON null. */
function redacted(frame: unknown): unknown {
  if (frame === null) return null;
  const { type, data } = frame as { type: unknown; data: Row };
  const next = { ...data };
  for (const key of ['msg', 'fallback_q']) if (key in next) next[key] = null;
  return { type, data: next };
}

async function ownedBy() {
  const userId = await h.user();
  const first = await h.conversation({ userId });
  const second = await h.conversation({ userId });
  return {
    userId,
    conversations: [first, second] as const,
    sessionIds: [first.sessionId, second.sessionId] as const,
    runIds: [...first.runIds, ...second.runIds],
  };
}

it('[AC-B3-09e#1][BR-AI-22] 该用户各会话的 user 与 assistant 消息行都保留，text、report_reason、report_note 为 NULL，返回清掉的行数', async () => {
  const { userId, sessionIds } = await ownedBy();
  const before = await h.rows('agent_messages', sessionIds);
  expect(before).toHaveLength(10);
  expect(new Set(before.map((row) => row['role']))).toEqual(new Set(['user', 'assistant']));

  expect(await h.purge({ appId: APP, userId, at: AT })).toStrictEqual({
    sessions: 2,
    messages: 10,
  });

  const after = await h.rows('agent_messages', sessionIds);
  const unstamped = ['updated_at', 'row_version'];
  expect(after.map((row) => omit(row, unstamped))).toEqual(
    before.map((row) => ({
      ...omit(row, unstamped),
      text: null,
      report_reason: null,
      report_note: null,
    })),
  );
});

it('[AC-B3-09e#2][BR-AI-22] agent_runs.user_text 为 NULL；final_event / end_draft 只把已有的 data.msg、data.fallback_q 置 JSON null', async () => {
  const { userId, sessionIds, conversations } = await ownedBy();
  const before = await h.rows('agent_runs', sessionIds);
  expect(before).toHaveLength(6);

  await h.purge({ appId: APP, userId, at: AT });

  const after = await h.rows('agent_runs', sessionIds);
  // quota_subjects is [AC-B3-09e#7]; runs keep updated_at (only sessions take `at`).
  const elsewhere = ['quota_subjects', 'row_version'];
  expect(after.map((row) => omit(row, elsewhere))).toEqual(
    before.map((row) => ({
      ...omit(row, elsewhere),
      user_text: null,
      final_event: redacted(row['final_event']),
      end_draft: redacted(row['end_draft']),
    })),
  );

  const byId = new Map(after.map((row) => [row['id'], row]));
  for (const { runIds } of conversations) {
    const [done, failed, open] = runIds.map((id) => byId.get(id));
    // A done event has neither key: unchanged, nothing added.
    expect(done?.['final_event']).toStrictEqual(doneFrame());
    expect(done?.['end_draft']).toBeNull();
    for (const column of ['final_event', 'end_draft']) {
      const data = frameData(failed?.[column]);
      expect(data).toStrictEqual({
        code: 50302,
        msg: null,
        retryable: true,
        fallback: 'search_page',
        fallback_q: null,
      });
      expect((failed?.[column] as Row)['type']).toBe('error');
    }
    // fallback_q was absent: msg is cleared and fallback_q is not added.
    const draft = frameData(open?.['end_draft']);
    expect(draft).toStrictEqual({ code: 50001, msg: null, retryable: false, fallback: null });
    expect(Object.hasOwn(draft, 'fallback_q')).toBe(false);
    expect(open?.['final_event']).toBeNull();
  }
  const texts = await sql<{ n: number }>`SELECT count(*)::int AS n FROM app.agent_runs
    WHERE app_id = ${APP} AND id = ANY(${[...byId.keys()]}::uuid[]) AND user_text IS NOT NULL`.execute(
    h.db(),
  );
  expect(texts.rows).toEqual([{ n: 0 }]);
});

it('[AC-B3-09e#3][BR-AI-22] agent_tool_calls.args 为 SQL NULL，name、seq、status、latency_ms、result_digest、created_at 不变', async () => {
  const { userId, sessionIds, runIds } = await ownedBy();
  const before = await h.rows('agent_tool_calls', sessionIds);
  expect(before).toHaveLength(8);

  await h.purge({ appId: APP, userId, at: AT });

  const after = await h.rows('agent_tool_calls', sessionIds);
  expect(after).toEqual(before.map((row) => ({ ...row, args: null })));
  // SQL NULL, not '{}' and not the JSON null the driver would also read back as null.
  const notSqlNull = await sql<{ n: number }>`SELECT count(*)::int AS n FROM app.agent_tool_calls
    WHERE app_id = ${APP} AND run_id = ANY(${runIds}::uuid[]) AND args IS NOT NULL`.execute(h.db());
  expect(notSqlNull.rows).toEqual([{ n: 0 }]);
});

it('[AC-B3-09e#4][BR-AI-22] agent_cards.data 为 {}，fallback_text 为「内容已删除」，其余列不变', async () => {
  const { userId, sessionIds } = await ownedBy();
  const before = await h.rows('agent_cards', sessionIds);
  expect(before).toHaveLength(4);

  await h.purge({ appId: APP, userId, at: AT });

  expect(purgedCardText()).toBe(PLACEHOLDER);
  const after = await h.rows('agent_cards', sessionIds);
  expect(after).toEqual(before.map((row) => ({ ...row, data: {}, fallback_text: PLACEHOLDER })));
  for (const row of after) {
    const original = before.find((candidate) => candidate['id'] === row['id']);
    for (const column of ['card_id', 'type', 'link_id', 'run_id', 'session_id', 'created_at']) {
      expect(row[column]).toEqual(original?.[column]);
    }
  }
});

it('[AC-B3-09e#5][BR-AI-22] 结果集 conditions、投递 card 为 {}，结果链 conditions 只含本行 chain_id，行都在，clarify 不变', async () => {
  const { userId, sessionIds } = await ownedBy();
  const before = {
    sets: await h.rows('agent_result_sets', sessionIds),
    deliveries: await h.rows('agent_result_deliveries', sessionIds),
    chains: await h.rows('agent_result_chains', sessionIds),
    asks: await h.rows('agent_clarify_asks', sessionIds),
  };
  expect(before.sets).toHaveLength(2);
  expect(before.deliveries).toHaveLength(2);
  expect(before.chains).toHaveLength(4);
  expect(before.asks).toHaveLength(2);

  await h.purge({ appId: APP, userId, at: AT });

  expect(await h.rows('agent_result_sets', sessionIds)).toEqual(
    before.sets.map((row) => ({ ...row, conditions: {} })),
  );
  expect(await h.rows('agent_result_deliveries', sessionIds)).toEqual(
    before.deliveries.map((row) => ({ ...row, card: {} })),
  );
  expect(await h.rows('agent_result_chains', sessionIds)).toEqual(
    before.chains.map((row) => ({ ...row, conditions: { chain_id: row['chain_id'] } })),
  );
  expect(await h.rows('agent_clarify_asks', sessionIds)).toEqual(before.asks);
});

it('[AC-B3-09e#6][BR-AI-22] 网络日志最小字段原样保留：run 的 id、accepted_at、created_at、finish_reason、session_id，session 的 device_id、started_at', async () => {
  const { userId, sessionIds } = await ownedBy();
  const runFields = ['id', 'accepted_at', 'created_at', 'finish_reason', 'session_id'];
  const sessionFields = ['id', 'device_id', 'started_at'];
  const pick = (rows: Row[], names: string[]) =>
    rows.map((row) => Object.fromEntries(names.map((name) => [name, row[name]])));
  const runs = pick(await h.rows('agent_runs', sessionIds), runFields);
  const sessions = pick(await h.rows('agent_sessions', sessionIds), sessionFields);
  expect(runs).toHaveLength(6);
  expect(runs.map((row) => row['finish_reason'])).toEqual(
    expect.arrayContaining(['stop', 'error', null]),
  );
  expect(sessions.every((row) => (row['started_at'] as Date).getTime() === SEEDED.getTime())).toBe(
    true,
  );

  await h.purge({ appId: APP, userId, at: AT });

  expect(pick(await h.rows('agent_runs', sessionIds), runFields)).toEqual(runs);
  expect(pick(await h.rows('agent_sessions', sessionIds), sessionFields)).toEqual(sessions);
});

it('[AC-B3-09e#7][BR-AI-22] 会话断开 user_id 并写 HMAC 用户哈希，updated_at = at；quota_subjects 的 member 换成同一哈希', async () => {
  const { userId, sessionIds } = await ownedBy();
  const sessions = await h.rows('agent_sessions', sessionIds);
  const runs = await h.rows('agent_runs', sessionIds);
  expect(sessions.map((row) => row['user_id'])).toEqual([userId, userId]);
  expect(runs.flatMap((row) => row['quota_subjects'] as string[])).toContain(memberSubject(userId));

  await h.purge({ appId: APP, userId, at: AT });

  const hash = expectedHash(KEY, userId);
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(hash).not.toBe(createHash('sha256').update(userId, 'utf8').digest('hex'));
  expect(await h.rows('agent_sessions', sessionIds)).toEqual(
    sessions.map((row) => ({
      ...row,
      user_id: null,
      user_hash: hash,
      updated_at: AT,
      row_version: (row['row_version'] as number) + 1,
    })),
  );
  const member = memberSubject(hash);
  const after = await h.rows('agent_runs', sessionIds);
  expect(after.map((row) => [row['id'], row['quota_subjects']])).toEqual(
    runs.map((row) => [
      row['id'],
      (row['quota_subjects'] as string[]).map((subject) =>
        subject === memberSubject(userId) ? member : subject,
      ),
    ]),
  );
  // The guest tuples stay where they were; only the member position changes.
  expect(after.flatMap((row) => row['quota_subjects'] as string[])).not.toContain(
    memberSubject(userId),
  );
});

it('[AC-B3-09e#7][BR-AI-22] 换密钥哈希不同，且仍是该密钥的 HMAC', async () => {
  const userId = await h.user();
  const { sessionId } = await h.conversation({ userId });

  expect(await h.purge({ appId: APP, userId, at: AT }, OTHER_KEY)).toStrictEqual({
    sessions: 1,
    messages: 5,
  });

  const [session] = await h.rows('agent_sessions', [sessionId]);
  expect(session?.['user_hash']).toBe(expectedHash(OTHER_KEY, userId));
  expect(session?.['user_hash']).not.toBe(expectedHash(KEY, userId));
  const runs = await h.rows('agent_runs', [sessionId]);
  expect(runs.flatMap((row) => row['quota_subjects'] as string[])).toContain(
    memberSubject(expectedHash(OTHER_KEY, userId)),
  );
});

it('[AC-B3-09e#7][BR-AI-22] 清理后所有 agent_* 表的任何列都不含该用户编号明文', async () => {
  const { userId } = await ownedBy();
  const seeded = await h.occurrences(userId);
  // The fixture puts the id in every free-text column and in user_id / quota_subjects.
  for (const table of TABLES) {
    if (table === 'agent_clarify_asks') continue;
    expect(seeded[table], `${table} carries the id before the purge`).toBeGreaterThan(0);
  }

  await h.purge({ appId: APP, userId, at: AT });

  const none = Object.fromEntries(TABLES.map((table): [Table, number] => [table, 0]));
  expect(await h.occurrences(userId)).toEqual(none);
});
