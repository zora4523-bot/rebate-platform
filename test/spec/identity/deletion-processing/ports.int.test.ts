// B1-15g: the cross-module cleanup ports (brief §9.2 #2, #3 ①, #4, #6; §9.3 items 6, 7):
// - every port is called once per cleanup with the caller's transaction (users row locked) and
//   exactly { appId, userId, at = the step's now };
// - a throwing port rolls the whole cleanup back, one warn identity_deletion_cleanup_failed
//   (app_id, deletion_request_id, error_name only; once a day) and the next round succeeds;
// - an unavailable port (the marker app.module assembles until the owner ships) lets the rest of
//   the cleanup commit but keeps cleaned_at NULL, the request in processing, Apple untouched, one
//   identity_deletion_cleanup_blocked line per port and day.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  CLEANUP_BLOCKED,
  CLEANUP_FAILED,
  DAY_MS,
  HOUR_MS,
  PORT_NAMES,
  TOMBSTONE_NICKNAME,
  at,
  close,
  device,
  fields,
  footprint,
  loginLog,
  loginLogsOf,
  oauth,
  open,
  payoutAccount,
  processing,
  realname,
  request,
  reset,
  session,
  sessionsOf,
  userRow,
  warnings,
  type Kit,
} from './kit.ts';

let database: TestDatabase;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  kit = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    await database?.drop();
  }
});
beforeEach(async () => {
  await reset(kit);
});

class PortDown extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortDown';
  }
}

/** A processing user with something to clean in every identity-owned table. */
async function populated() {
  const { m, row } = await processing(kit.db);
  const d = await device(kit.db, m.appId);
  await session(kit.db, m, d.id);
  await loginLog(kit.db, m, d.hash);
  await oauth(kit.db, m, 'wechat');
  await realname(kit.db, m);
  await payoutAccount(kit.db, m, 'alipay', true);
  return { m, row };
}

it('[AC-B1-15g#13] 五个跨模块端口各被调一次：调用方事务、users 行已锁、入参恰为 {appId, userId, at=now}', async () => {
  const { m } = await processing(kit.db);
  await kit.runner().runOnce();
  const now = kit.clock.now();
  for (const name of PORT_NAMES) {
    expect(kit.callsOf(name, m), name).toEqual([
      {
        port: name,
        input: { appId: m.appId, userId: m.uid, at: now },
        inTransaction: true,
        userRowLocked: true,
      },
    ]);
  }
});

it.each(PORT_NAMES)(
  '[AC-B1-15g#14] %s 端口抛错 → 清理整笔回滚、单留在 processing；同日两轮只 warn 一次 cleanup_failed（只带 app_id / deletion_request_id / error_name）；修好后下一轮完成',
  async (name) => {
    const { m, row } = await populated();
    const before = await footprint(kit.db, m, row.id);
    kit.setFailure(name, new PortDown('synthetic-port-detail 13800138000'));
    const runner = kit.runner();
    await runner.runOnce();
    kit.clock.set(at(HOUR_MS));
    await runner.runOnce();
    expect(await footprint(kit.db, m, row.id)).toEqual(before);
    const failed = warnings(kit, CLEANUP_FAILED, m.appId);
    expect(failed.map(fields)).toEqual([
      { app_id: m.appId, deletion_request_id: row.id, error_name: 'PortDown' },
    ]);
    expect(kit.lines.join('')).not.toContain('synthetic-port-detail');
    expect(kit.lines.join('')).not.toContain('13800138000');
    kit.clearFailure(name);
    kit.clock.set(at(2 * HOUR_MS));
    await runner.runOnce();
    expect(await request(kit.db, row.id)).toMatchObject({
      status: 'done',
      cleaned_at: kit.clock.now(),
      processed_at: kit.clock.now(),
    });
  },
);

it('[AC-B1-15g#15] 一单出错（只记它的 warn）不影响同轮其他单完成', async () => {
  const failing = await populated();
  const fine = await populated();
  const before = await footprint(kit.db, failing.m, failing.row.id);
  kit.setFailure('agent', new PortDown('synthetic-port-detail'), failing.m);
  await kit.runner().runOnce();
  expect(await footprint(kit.db, failing.m, failing.row.id)).toEqual(before);
  expect(await request(kit.db, fine.row.id)).toMatchObject({
    status: 'done',
    cleaned_at: kit.clock.now(),
  });
  expect(warnings(kit, CLEANUP_FAILED).map(fields)).toEqual([
    { app_id: failing.m.appId, deletion_request_id: failing.row.id, error_name: 'PortDown' },
  ]);
});

it('[AC-B1-15g#16] 未上线端口（linking、catalog）→ 其余清理照常提交，cleaned_at 仍空、单不 done、不做 Apple 与完成事务；每端口每日一行 cleanup_blocked', async () => {
  kit.setUnavailable('linking', 'W1');
  kit.setUnavailable('catalog', 'W1');
  const { m, row } = await populated();
  await oauth(kit.db, m, 'apple', { appleToken: 'synthetic-apple-refresh', crypto: kit.crypto });
  const runner = kit.runner();
  await runner.runOnce();
  const now = kit.clock.now();
  expect(await request(kit.db, row.id)).toEqual(row);
  expect(await userRow(kit.db, m)).toMatchObject({
    status: 'deleting',
    phone_hmac: m.phoneHmac,
    nickname: TOMBSTONE_NICKNAME,
  });
  expect(
    (await sessionsOf(kit.db, m.appId)).every(
      (s) => s.revoked_at?.getTime() === now.getTime() && s.revoke_reason === 'account_deleted',
    ),
  ).toBe(true);
  expect((await loginLogsOf(kit.db, m.appId)).map((log) => log.user_id)).toEqual([null]);
  for (const name of ['growth', 'notification', 'agent'] as const) {
    expect(kit.callsOf(name, m), name).toHaveLength(1);
  }
  expect(kit.appleCalls).toEqual([]);
  expect(kit.callsOf('funds', m)).toEqual([]);
  const blockedLines = () =>
    warnings(kit, CLEANUP_BLOCKED, m.appId)
      .map(fields)
      .sort((a, b) => String(a['port']).localeCompare(String(b['port'])));
  const expected = ['catalog', 'linking'].map((port) => ({
    app_id: m.appId,
    deletion_request_id: row.id,
    port,
  }));
  expect(blockedLines()).toEqual(expected);
  // Same +08:00 day: no new line; the request still waits.
  kit.clock.set(at(2 * HOUR_MS));
  await runner.runOnce();
  expect(blockedLines()).toEqual(expected);
  expect((await request(kit.db, row.id)).status).toBe('processing');
  // Next day: one line per port again.
  kit.clock.set(at(DAY_MS));
  await runner.runOnce();
  expect(blockedLines()).toEqual(
    [...expected, ...expected].sort((a, b) => a.port.localeCompare(b.port)),
  );
  expect(await request(kit.db, row.id)).toEqual(row);
  // The owners ship: a runner with the real ports finishes the request.
  kit.setAvailable('linking');
  kit.setAvailable('catalog');
  kit.clock.set(at(DAY_MS + HOUR_MS));
  await kit.runner().runOnce();
  expect(await request(kit.db, row.id)).toMatchObject({
    status: 'done',
    cleaned_at: kit.clock.now(),
  });
});
