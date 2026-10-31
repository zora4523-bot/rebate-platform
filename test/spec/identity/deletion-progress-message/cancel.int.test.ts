// B1-15i over HTTP: a successful POST /v1/me/deletion/cancel writes one DELETION_PROGRESS cancelled
// inbox message on the cancel's transaction (08 BR-TEXT-23 细则模板表, BR-ID-27 细则「站内信」;
// brief §9.2 #1, #3, #4, §9.3). Answers that change nothing (past the cutoff 10007, never applied,
// already cancelled) write nothing; inbox only; rolled back with the cancel.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  COOLING_MS,
  INSTANT,
  deletion,
  deletionData,
  failed,
  requests,
  seedRequest,
  user,
} from '../deletion-request/kit.ts';
import {
  CANCELLED_BODY,
  TITLE,
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

it('[AC-B1-15i#20] 申请后撤回 → 先 requested、再一条 cancelled「已撤回注销申请，账号恢复正常使用。」，各一条 inbox 日志，不推送不短信', async () => {
  f.clock.set(INSTANT);
  const u = await user(f);
  const t0 = f.clock.now();
  await deletion(await u.apply({ stepUp: await u.mint() }));
  f.clock.advanceMs(3_000);
  const t1 = f.clock.now();
  const data = await deletion(await u.cancel());
  expect(data).toMatchObject({ status: 'cancelled', cancel_reason: 'user' });
  const [row] = await requests(f, u.appId, u.uid);
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
  ]);
  expect(await logs(f.db, u.appId)).toEqual([
    expect.objectContaining(
      expectedLog({
        appId: u.appId,
        userId: u.uid,
        requestId: row!.id,
        variant: 'requested',
        at: t0,
      }),
    ),
    expect.objectContaining(
      expectedLog({
        appId: u.appId,
        userId: u.uid,
        requestId: row!.id,
        variant: 'cancelled',
        at: t1,
      }),
    ),
  ]);
  await expectInboxOnly(f.db, u.appId);
});

it('[AC-B1-15i#21] 冷静期内撤回（直接写入的 cooling 单）→ 一条 cancelled；重复撤回原样返回，不再写', async () => {
  f.clock.set(INSTANT);
  const u = await user(f);
  const now = f.clock.now();
  const id = await seedRequest(f, u.appId, u.uid, 'cooling', new Date(now.getTime() - 86_400_000));
  expect((await deletion(await u.cancel())).status).toBe('cancelled');
  f.clock.advanceMs(5_000);
  expect((await deletion(await u.cancel())).status).toBe('cancelled');
  expect(await inbox(f.db, u.appId)).toEqual([
    expect.objectContaining(
      expectedMessage({ appId: u.appId, userId: u.uid, body: CANCELLED_BODY, at: now }),
    ),
  ]);
  expect(await logs(f.db, u.appId)).toEqual([
    expect.objectContaining(
      expectedLog({ appId: u.appId, userId: u.uid, requestId: id, variant: 'cancelled', at: now }),
    ),
  ]);
});

it('[AC-B1-15i#22] 没改状态的撤回不写信：冷静期已过（10007）、从未申请（data null）、系统已撤销（negative_balance）；同 app 成功撤回的人照写', async () => {
  f.clock.set(INSTANT);
  const late = await user(f);
  const app = late.appId;
  const never = await user(f, { appId: app });
  const system = await user(f, { appId: app });
  const ok = await user(f, { appId: app });
  const now = f.clock.now();
  await seedRequest(f, app, late.uid, 'cooling', new Date(now.getTime() - COOLING_MS));
  await seedRequest(f, app, system.uid, 'cancelled', new Date(now.getTime() - COOLING_MS), {
    cancelReason: 'negative_balance',
  });
  const okId = await seedRequest(f, app, ok.uid, 'cooling', new Date(now.getTime() - 60_000));
  await failed(await late.cancel(), 403, 10007);
  expect(await deletionData(await never.cancel())).toBeNull();
  expect((await deletion(await system.cancel())).cancel_reason).toBe('negative_balance');
  expect((await deletion(await ok.cancel())).status).toBe('cancelled');
  expect(await inbox(f.db, app)).toEqual([
    expect.objectContaining(
      expectedMessage({ appId: app, userId: ok.uid, body: CANCELLED_BODY, at: now }),
    ),
  ]);
  expect(await logs(f.db, app)).toEqual([
    expect.objectContaining(
      expectedLog({ appId: app, userId: ok.uid, requestId: okId, variant: 'cancelled', at: now }),
    ),
  ]);
});

it('[AC-B1-15i#23] notify_templates 覆盖 cancelled 生效；别的 app 照默认', async () => {
  f.clock.set(INSTANT);
  const a = await user(f);
  const b = await user(f);
  await template(f.db, a.appId, 'cancelled', { title_override: '撤回成功', body_override: null });
  const before = new Date(f.clock.now().getTime() - 60_000);
  await seedRequest(f, a.appId, a.uid, 'cooling', before);
  await seedRequest(f, b.appId, b.uid, 'cooling', before);
  await deletion(await a.cancel());
  await deletion(await b.cancel());
  expect(await inbox(f.db, a.appId)).toEqual([
    expect.objectContaining({ user_id: a.uid, title: '撤回成功', body: CANCELLED_BODY }),
  ]);
  expect(await inbox(f.db, b.appId)).toEqual([
    expect.objectContaining({ user_id: b.uid, title: TITLE, body: CANCELLED_BODY }),
  ]);
});

it.each(['inbox_messages', 'notify_logs'] as const)(
  '[AC-B1-15i#24] 写 %s 失败 → 撤回回滚：单仍是 cooling、无站内信无日志；再撤回成功只一条',
  async (table: FailTable) => {
    f.clock.set(INSTANT);
    const u = await user(f);
    const id = await seedRequest(
      f,
      u.appId,
      u.uid,
      'cooling',
      new Date(f.clock.now().getTime() - 60_000),
    );
    const before = f.failure.fired();
    f.failure.arm(table);
    let refused: Awaited<ReturnType<typeof u.cancel>>;
    try {
      refused = await u.cancel();
    } finally {
      f.failure.disarm();
    }
    expect(f.failure.fired()).toBe(before + 1);
    expect(refused.statusCode).toBeGreaterThanOrEqual(500);
    expect(await requests(f, u.appId, u.uid)).toEqual([
      expect.objectContaining({ id, status: 'cooling', cancelled_at: null, row_version: 0 }),
    ]);
    expect(await inbox(f.db, u.appId)).toEqual([]);
    expect(await logs(f.db, u.appId)).toEqual([]);
    f.clock.advanceMs(1_000);
    const at = f.clock.now();
    expect((await deletion(await u.cancel())).status).toBe('cancelled');
    expect(await inbox(f.db, u.appId)).toEqual([
      expect.objectContaining(
        expectedMessage({ appId: u.appId, userId: u.uid, body: CANCELLED_BODY, at }),
      ),
    ]);
    expect(await logs(f.db, u.appId)).toEqual([
      expect.objectContaining(
        expectedLog({ appId: u.appId, userId: u.uid, requestId: id, variant: 'cancelled', at }),
      ),
    ]);
  },
);
