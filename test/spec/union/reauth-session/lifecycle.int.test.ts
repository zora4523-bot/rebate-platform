import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  CODE,
  TTL,
  account,
  credentials,
  databaseFixture,
  harness,
  seed,
  session,
  snapshot,
  start,
} from './kit.ts';

const db = databaseFixture();

it('[AC-B1-22c#17] result 同时约束 app、联盟账号和会话 id，越权读取不触发过期写入', async () => {
  const h = await harness(db());
  const a = await seed(h);
  const other = await seed(h);
  const s = await start(h, a.id);
  h.clock.advanceMs(TTL);
  const before = await snapshot(h);
  for (const input of [
    { appId: `${h.appId}-other`, unionAccountId: a.id, sessionId: s.sessionId },
    { appId: h.appId, unionAccountId: other.id, sessionId: s.sessionId },
    { appId: h.appId, unionAccountId: a.id, sessionId: randomUUID() },
  ]) {
    expect(await h.service.result(input)).toBeNull();
    expect(await snapshot(h)).toEqual(before);
  }
  expect(h.exchange).not.toHaveBeenCalled();
});

it('[AC-B1-22c#18] result 在到期边界按 expired 返回，读时落库可选，且不换码', async () => {
  const h = await harness(db());
  const a = await seed(h);
  const s = await start(h, a.id);
  const input = { appId: h.appId, unionAccountId: a.id, sessionId: s.sessionId };
  h.clock.advanceMs(TTL - 1);
  expect(await h.service.result(input)).toEqual({
    status: 'pending',
    error: null,
    finishedAt: null,
  });
  h.clock.advanceMs(1);
  expect(await h.service.result(input)).toMatchObject({ status: 'expired' });
  const row = await session(h, s.sessionId);
  expect(['pending', 'expired']).toContain(row.status);
  expect(row.used_at).toBeNull();
  if (row.status === 'expired') expect(row.finished_at).toEqual(h.clock.now());
  expect(await account(h, a.id)).toEqual(a);
  expect(await credentials(h)).toHaveLength(0);
  expect(h.exchange).not.toHaveBeenCalled();
});

it('[AC-B1-22c#19] expireStale 只结束到期未用会话，覆盖多 app；重复巡检返回零', async () => {
  const h = await harness(db());
  const a = await seed(h);
  const succeeded = await start(h, a.id);
  expect(
    await h.service.callback({ state: succeeded.state, code: CODE, error: null }),
  ).toMatchObject({ status: 'succeeded' });
  const failed = await start(h, a.id);
  expect(
    await h.service.callback({ state: failed.state, code: null, error: 'access_denied' }),
  ).toMatchObject({ status: 'failed' });
  const expired = await start(h, a.id);
  const due = await start(h, a.id);
  h.clock.advanceMs(1);
  const almostDue = await start(h, a.id);
  const foreign = await harness(db());
  const foreignAccount = await seed(foreign);
  const foreignDue = await start(foreign, foreignAccount.id);
  h.clock.advanceMs(TTL - 1);
  expect(await h.service.callback({ state: expired.state, code: CODE, error: null })).toMatchObject(
    { status: 'expired' },
  );
  const fresh = await start(h, a.id);
  const before = await h.store
    .selectFrom('admin_union_auth_sessions')
    .selectAll()
    .orderBy('id')
    .execute();
  const eligible = before.filter(
    (row) => row.status === 'pending' && row.expires_at <= h.clock.now(),
  );
  expect(eligible.map((row) => row.id)).toEqual(
    expect.arrayContaining([due.sessionId, foreignDue.sessionId]),
  );
  const beforeOwn = await snapshot(h);
  const beforeForeign = await snapshot(foreign);
  const exchanges = h.exchange.mock.calls.length;
  expect(await h.service.expireStale()).toBe(eligible.length);
  const after = await h.store
    .selectFrom('admin_union_auth_sessions')
    .selectAll()
    .orderBy('id')
    .execute();
  for (const row of before) {
    const actual = after.find((entry) => entry.id === row.id);
    if (eligible.some((entry) => entry.id === row.id)) {
      expect(actual).toMatchObject({
        status: 'expired',
        used_at: null,
        finished_at: h.clock.now(),
      });
    } else {
      expect(actual).toEqual(row);
    }
  }
  expect((await session(h, almostDue.sessionId)).status).toBe('pending');
  expect((await session(h, fresh.sessionId)).status).toBe('pending');
  const afterOwn = await snapshot(h);
  const afterForeign = await snapshot(foreign);
  expect({ ...afterOwn, sessions: [] }).toEqual({ ...beforeOwn, sessions: [] });
  expect({ ...afterForeign, sessions: [] }).toEqual({ ...beforeForeign, sessions: [] });
  expect(h.exchange).toHaveBeenCalledTimes(exchanges);
  expect(await h.service.expireStale()).toBe(0);
  expect(
    await h.store.selectFrom('admin_union_auth_sessions').selectAll().orderBy('id').execute(),
  ).toEqual(after);
  for (const s of [due, foreignDue]) {
    expect(await h.service.callback({ state: s.state, code: CODE, error: null })).toMatchObject({
      status: 'invalid',
    });
  }
});
