// B1-15i over HTTP: POST /v1/me/deletion entering cooling writes one DELETION_PROGRESS requested
// inbox message on the business transaction (08 BR-TEXT-23 细则模板表, BR-ID-27 细则「站内信」;
// brief §9.2 #1, #3, #4, §9.3). {cancel_deadline} = cooling_until in BR-TEXT-11 future-time format
// (+08:00). Inbox only (no push, no SMS log), deduplicated by request + variant, rolled back with
// the application when anything in its transaction fails.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { INSTANT, deletion, failed, requests, seedBalance, user } from '../deletion-request/kit.ts';
import {
  CANCELLED_BODY,
  expectInboxOnly,
  expectedLog,
  expectedMessage,
  inbox,
  logs,
  openHttp,
  requestedBody,
  template,
  type FailTable,
  type HttpFixture,
} from './kit.ts';

let f: HttpFixture;
beforeAll(async () => {
  f = await openHttp();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

it('[AC-B1-15i#10] 申请注销进入冷静期 → 本人一条 requested（标题「注销进度」，{cancel_deadline}=cooling_until +08:00），一条 inbox 成功日志，不推送不短信', async () => {
  f.clock.set(INSTANT);
  const u = await user(f);
  const at = f.clock.now();
  const data = await deletion(await u.apply({ stepUp: await u.mint() }));
  expect(data.status).toBe('cooling');
  const rows = await requests(f, u.appId, u.uid);
  expect(rows).toHaveLength(1);
  // 2026-10-16T02:00Z + 7×24 h = 2026-10-23T02:00Z = 10-23 10:00 (+08:00).
  expect(await inbox(f.db, u.appId)).toEqual([
    expect.objectContaining(
      expectedMessage({ appId: u.appId, userId: u.uid, body: requestedBody('10-23 10:00'), at }),
    ),
  ]);
  expect(await logs(f.db, u.appId)).toEqual([
    expect.objectContaining(
      expectedLog({
        appId: u.appId,
        userId: u.uid,
        requestId: rows[0]!.id,
        variant: 'requested',
        at,
      }),
    ),
  ]);
  await expectInboxOnly(f.db, u.appId);
});

it.each([
  ['UTC 下午申请，+08:00 截止已是次日', '2026-10-16T17:30:00.000Z', '10-24 01:30'],
  ['+08:00 截止跨年，带年份', '2026-12-24T16:30:00.000Z', '2027-01-01 00:30'],
  ['申请时 +08:00 已是新年，截止同年不带年份', '2026-12-31T16:30:00.000Z', '01-08 00:30'],
] as const)('[AC-B1-15i#11] %s：%s 申请 → 「%s」', async (_name, applyAt, deadline) => {
  f.clock.set(applyAt);
  const u = await user(f);
  const data = await deletion(await u.apply({ stepUp: await u.mint() }));
  expect(Date.parse(data.cooling_until) - Date.parse(applyAt)).toBe(7 * 24 * 60 * 60 * 1000);
  const messages = await inbox(f.db, u.appId, u.uid);
  expect(messages.map((row) => row.body)).toEqual([requestedBody(deadline)]);
});

it('[AC-B1-15i#12] 同键重放、冷静期内再申请都不重复写；撤回后再申请是新申请，另写一条 requested（按申请编号 + 变体去重）', async () => {
  f.clock.set(INSTANT);
  const u = await user(f);
  const key = randomUUID();
  const token = await u.mint();
  const t0 = f.clock.now();
  const first = await deletion(await u.apply({ stepUp: token, key }));
  expect(first.status).toBe('cooling');
  f.clock.advanceMs(1_000);
  const replay = await u.apply({ stepUp: token, key });
  expect(replay.statusCode).toBeLessThan(500);
  f.clock.advanceMs(1_000);
  const again = await u.apply({ stepUp: await u.mint() });
  if (f.deletionGuard) await failed(again, 403, 10007);
  else expect((await deletion(again)).apply_at).toBe(first.apply_at);
  const [r1] = await requests(f, u.appId, u.uid);
  expect(await inbox(f.db, u.appId)).toEqual([
    expect.objectContaining(
      expectedMessage({
        appId: u.appId,
        userId: u.uid,
        body: requestedBody('10-23 10:00'),
        at: t0,
      }),
    ),
  ]);
  expect(await logs(f.db, u.appId)).toHaveLength(1);
  // Withdrawn, then a new application: a new request, so its own requested message.
  f.clock.advanceMs(1_000);
  const t1 = f.clock.now();
  expect((await deletion(await u.cancel())).status).toBe('cancelled');
  f.clock.advanceMs(1_000);
  const t2 = f.clock.now();
  const second = await deletion(await u.apply({ stepUp: await u.mint() }));
  expect(second.status).toBe('cooling');
  const all = await requests(f, u.appId, u.uid);
  expect(all).toHaveLength(2);
  const r2 = all.find((row) => row.id !== r1!.id)!;
  expect(await inbox(f.db, u.appId)).toEqual([
    expect.objectContaining(
      expectedMessage({
        appId: u.appId,
        userId: u.uid,
        body: requestedBody('10-23 10:00'),
        at: t0,
      }),
    ),
    expect.objectContaining(
      expectedMessage({ appId: u.appId, userId: u.uid, body: CANCELLED_BODY, at: t1 }),
    ),
    expect.objectContaining(
      expectedMessage({
        appId: u.appId,
        userId: u.uid,
        body: requestedBody('10-23 10:00'),
        at: t2,
      }),
    ),
  ]);
  expect((await logs(f.db, u.appId)).map((row) => row.dedupe_key).sort()).toEqual(
    [
      `${r1!.id}:DELETION_PROGRESS:requested`,
      `${r1!.id}:DELETION_PROGRESS:cancelled`,
      `${r2.id}:DELETION_PROGRESS:requested`,
    ].sort(),
  );
  await expectInboxOnly(f.db, u.appId);
});

it('[AC-B1-15i#13] 被拒的申请（30416 余额为负）不写信；回正后申请成功才写一条', async () => {
  f.clock.set(INSTANT);
  const u = await user(f);
  await seedBalance(f, u.appId, u.uid, -500n);
  await failed(await u.apply({ stepUp: await u.mint() }), 422, 30416);
  expect(await inbox(f.db, u.appId)).toEqual([]);
  expect(await logs(f.db, u.appId)).toEqual([]);
  await f.db
    .withSchema('app')
    .updateTable('account_balances')
    .set({ available_fen: 0n })
    .where('app_id', '=', u.appId)
    .execute();
  f.clock.advanceMs(1_000);
  const at = f.clock.now();
  expect((await deletion(await u.apply({ stepUp: await u.mint() }))).status).toBe('cooling');
  expect(await inbox(f.db, u.appId)).toEqual([
    expect.objectContaining(
      expectedMessage({ appId: u.appId, userId: u.uid, body: requestedBody('10-23 10:00'), at }),
    ),
  ]);
  expect(await logs(f.db, u.appId)).toHaveLength(1);
});

it('[AC-B1-15i#14] 只写申请人本人：同 app 的别的用户、别的 app 都没有信', async () => {
  f.clock.set(INSTANT);
  const a = await user(f);
  const b = await user(f, { appId: a.appId });
  const c = await user(f);
  expect((await deletion(await a.apply({ stepUp: await a.mint() }))).status).toBe('cooling');
  const messages = await inbox(f.db, a.appId);
  expect(messages.map((row) => row.user_id)).toEqual([a.uid]);
  expect(await inbox(f.db, a.appId, b.uid)).toEqual([]);
  expect(await logs(f.db, a.appId, b.uid)).toEqual([]);
  expect(await inbox(f.db, c.appId)).toEqual([]);
  expect(await logs(f.db, c.appId)).toEqual([]);
});

it('[AC-B1-15i#15] notify_templates 覆盖 requested 生效（{cancel_deadline} 照填）；只覆盖别的变体或别的 app 的覆盖不影响', async () => {
  f.clock.set(INSTANT);
  const a = await user(f);
  const b = await user(f);
  await template(f.db, a.appId, 'requested', {
    title_override: '注销提醒',
    body_override: '注销申请已收到，{cancel_deadline} 前可撤回。',
  });
  await template(f.db, b.appId, 'cancelled', {
    title_override: '撤回结果',
    body_override: '撤回了。',
  });
  await deletion(await a.apply({ stepUp: await a.mint() }));
  await deletion(await b.apply({ stepUp: await b.mint() }));
  expect(await inbox(f.db, a.appId)).toEqual([
    expect.objectContaining({
      user_id: a.uid,
      code: 'DELETION_PROGRESS',
      title: '注销提醒',
      body: '注销申请已收到，10-23 10:00 前可撤回。',
    }),
  ]);
  expect(await inbox(f.db, b.appId)).toEqual([
    expect.objectContaining({
      user_id: b.uid,
      code: 'DELETION_PROGRESS',
      title: '注销进度',
      body: requestedBody('10-23 10:00'),
    }),
  ]);
});

it.each(['inbox_messages', 'notify_logs'] as const)(
  '[AC-B1-15i#16] 写 %s 失败 → 整个申请回滚：无申请单、无站内信、无日志；再申请成功只一条',
  async (table: FailTable) => {
    f.clock.set(INSTANT);
    const u = await user(f);
    const token = await u.mint();
    const before = f.failure.fired();
    f.failure.arm(table);
    let refused: Awaited<ReturnType<typeof u.apply>>;
    try {
      refused = await u.apply({ stepUp: token });
    } finally {
      f.failure.disarm();
    }
    // The notice was written on the business transaction (the injected failure fired there).
    expect(f.failure.fired()).toBe(before + 1);
    expect(refused.statusCode).toBeGreaterThanOrEqual(500);
    expect(await requests(f, u.appId, u.uid)).toEqual([]);
    expect(await inbox(f.db, u.appId)).toEqual([]);
    expect(await logs(f.db, u.appId)).toEqual([]);
    f.clock.advanceMs(1_000);
    const at = f.clock.now();
    expect((await deletion(await u.apply({ stepUp: await u.mint() }))).status).toBe('cooling');
    const rows = await requests(f, u.appId, u.uid);
    expect(rows).toHaveLength(1);
    expect(await inbox(f.db, u.appId)).toEqual([
      expect.objectContaining(
        expectedMessage({ appId: u.appId, userId: u.uid, body: requestedBody('10-23 10:00'), at }),
      ),
    ]);
    expect(await logs(f.db, u.appId)).toEqual([
      expect.objectContaining(
        expectedLog({
          appId: u.appId,
          userId: u.uid,
          requestId: rows[0]!.id,
          variant: 'requested',
          at,
        }),
      ),
    ]);
  },
);
