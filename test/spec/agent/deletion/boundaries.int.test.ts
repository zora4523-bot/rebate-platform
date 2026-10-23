// B3-09e (BR-AI-22): who is purged, re-entry, the caller's transaction and refused input.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  createAgentDataPurge,
  type PurgeAgentDataInput,
} from '../../../../apps/api/src/modules/agent/deletion/index.ts';
import { APP, AT, KEY, LATER, OTHER_APP, databaseKit, rejection } from './kit.ts';

const h = databaseKit(createTestDatabase);

class SyntheticRollback extends Error {}

it('[AC-B3-09e#8][BR-AI-22] 同 app 其他用户、同设备的游客会话、另一 app 的用户数据都不变', async () => {
  const target = await h.user();
  const other = await h.user();
  const foreignUser = await h.user(OTHER_APP);
  const mine = await h.conversation({ userId: target });
  const theirs = await h.conversation({ userId: other });
  // A guest session on the very device the member used: purging goes by user, never by device.
  const guest = await h.conversation({ userId: null, deviceId: mine.deviceId });
  const foreign = await h.conversation({ appId: OTHER_APP, userId: foreignUser });
  const kept = [theirs.sessionId, guest.sessionId];
  const keptBefore = await h.snapshot(kept);
  const foreignBefore = await h.snapshot([foreign.sessionId], OTHER_APP);
  const mineBefore = await h.snapshot([mine.sessionId]);

  expect(await h.purge({ appId: APP, userId: target, at: AT })).toStrictEqual({
    sessions: 1,
    messages: 5,
  });

  expect(await h.snapshot(kept)).toEqual(keptBefore);
  expect(await h.snapshot([foreign.sessionId], OTHER_APP)).toEqual(foreignBefore);
  // The target itself did change (so the comparison above has teeth).
  expect(await h.snapshot([mine.sessionId])).not.toEqual(mineBefore);
});

it('[AC-B3-09e#8][BR-AI-22] 按另一 app 清理同一用户编号时不动本 app 的数据', async () => {
  const userId = await h.user();
  const { sessionId } = await h.conversation({ userId });
  const before = await h.snapshot([sessionId]);

  expect(await h.purge({ appId: OTHER_APP, userId, at: AT })).toStrictEqual({
    sessions: 0,
    messages: 0,
  });
  expect(await h.snapshot([sessionId])).toEqual(before);

  expect(await h.purge({ appId: APP, userId, at: AT })).toStrictEqual({
    sessions: 1,
    messages: 5,
  });
});

it('[AC-B3-09e#9][BR-AI-22] 可重入：第二次不报错、返回 0、各表与第一次后相同；无数据的用户直接返回 0', async () => {
  const userId = await h.user();
  const first = await h.conversation({ userId });
  const second = await h.conversation({ userId });
  const sessionIds = [first.sessionId, second.sessionId];

  expect(await h.purge({ appId: APP, userId, at: AT })).toStrictEqual({
    sessions: 2,
    messages: 10,
  });
  const once = await h.snapshot(sessionIds);

  // A later retry of the cleanup must not restamp, rehash or touch anything.
  expect(await h.purge({ appId: APP, userId, at: LATER })).toStrictEqual({
    sessions: 0,
    messages: 0,
  });
  expect(await h.snapshot(sessionIds)).toEqual(once);

  const nobody = await h.user();
  expect(await h.purge({ appId: APP, userId: nobody, at: AT })).toStrictEqual({
    sessions: 0,
    messages: 0,
  });
  expect(await h.snapshot(sessionIds)).toEqual(once);
});

it('[AC-B3-09e#10][BR-AI-22] 在调用方事务内调用后再抛错，全部回滚', async () => {
  const port = createAgentDataPurge({ userHashKey: KEY });
  const userId = await h.user();
  const { sessionId, runIds } = await h.conversation({ userId });
  const before = await h.snapshot([sessionId]);

  await expect(
    h
      .db()
      .transaction()
      .execute(async (trx) => {
        expect(await port.purgeAgentDataForUser(trx, { appId: APP, userId, at: AT })).toStrictEqual(
          { sessions: 1, messages: 5 },
        );
        // Inside the caller's transaction the purge is visible …
        const inside = await sql<{ user_id: string | null }>`SELECT user_id FROM app.agent_sessions
          WHERE app_id = ${APP} AND id = ${sessionId}`.execute(trx);
        expect(inside.rows).toEqual([{ user_id: null }]);
        throw new SyntheticRollback('synthetic failure after the purge');
      }),
  ).rejects.toBeInstanceOf(SyntheticRollback);

  // … and the caller's rollback takes all of it back.
  const after = await h.snapshot([sessionId]);
  expect(after).toEqual(before);
  expect(after.agent_sessions.map((row) => row['user_id'])).toEqual([userId]);
  expect(after.agent_runs.every((row) => row['user_text'] !== null)).toBe(true);
  expect(after.agent_messages.every((row) => row['text'] !== null)).toBe(true);
  expect(after.agent_runs.map((row) => row['id']).sort()).toEqual([...runIds].sort());
});

it('[AC-B3-09e#12][BR-AI-22] 空 appId、空 userId、at 不是有效 Date 时抛错且不写入', async () => {
  const port = createAgentDataPurge({ userHashKey: KEY });
  const userId = await h.user();
  const { sessionId } = await h.conversation({ userId });
  const before = await h.snapshot([sessionId]);
  const invalid: readonly unknown[] = [
    { appId: '', userId, at: AT },
    { appId: '  ', userId, at: AT },
    { appId: APP, userId: '', at: AT },
    { appId: APP, userId: ' ', at: AT },
    { appId: APP, userId, at: AT.toISOString() },
    { appId: APP, userId, at: AT.getTime() },
    { appId: APP, userId },
    { appId: APP, userId, at: new Date(Number.NaN) },
  ];
  for (const input of invalid) {
    await rejection(() =>
      h
        .db()
        .transaction()
        .execute((trx) => port.purgeAgentDataForUser(trx, input as PurgeAgentDataInput)),
    );
    expect(await h.snapshot([sessionId])).toEqual(before);
  }

  // The same data is purgeable with valid input, so the refusals above were about the input.
  expect(await h.purge({ appId: APP, userId, at: AT })).toStrictEqual({
    sessions: 1,
    messages: 5,
  });
});
