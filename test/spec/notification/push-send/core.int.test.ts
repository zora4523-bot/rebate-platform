import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPushSendCore } from '../../../../apps/api/src/modules/notification/application/push-send.ts';
import { createPushSessionValidity } from '../../../../apps/api/src/modules/identity/ports/push-session-validity.ts';
import { fixture, seedSession, seedUser, type Fixture } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 60_000);
afterAll(async () => {
  if (db) await destroyDb(db);
  if (database) await database.drop();
}, 60_000);

const ON = { service_push: true, subscription_push: true, marketing_push: true };
const OFF = { service_push: false, subscription_push: false, marketing_push: false };
const categories = ['service', 'subscription', 'marketing'] as const;
const combinations = [false, true].flatMap((service_push) =>
  [false, true].flatMap((subscription_push) =>
    [false, true].map((marketing_push) => ({ service_push, subscription_push, marketing_push })),
  ),
);

it.each(['ORDER_TRACKED', 'CREDITED', 'WD_SUCCESS', 'WD_FAILED'])(
  '[AC-B1-12o#29] BR-TEXT-09 服务类关闭时 %s 保留站内信、抑制推送，本核心不发短信',
  async (code) => {
    const f = await fixture(db, code);
    await f.registration();
    await f.template('service');
    await f.settings({ ...ON, service_push: false });
    await f.send();
    expect(f.channel.send).not.toHaveBeenCalled();
    await assertRecords(f, 'suppressed');
    expect((await f.rows()).logs.map((row) => row.channel).sort()).toEqual(['inbox', 'push']);
  },
);

async function assertRecords(f: Fixture, status: 'success' | 'failed' | 'suppressed') {
  const { inbox, logs } = await f.rows();
  expect(inbox).toHaveLength(1);
  expect(inbox[0]).toMatchObject({
    app_id: f.app_id,
    user_id: f.user_id,
    code: f.input.code,
    title: f.input.title,
    body: f.input.body,
    route: f.input.route,
    created_at: f.clock.now(),
    updated_at: f.clock.now(),
    read_at: null,
  });
  expect(logs).toHaveLength(2);
  expect(logs.find((row) => row.channel === 'inbox')).toMatchObject({
    app_id: f.app_id,
    user_id: f.user_id,
    code: f.input.code,
    dedupe_key: f.input.eventKey,
    status: 'success',
    suppress_reason: null,
    planned_at: f.clock.now(),
    sent_at: f.clock.now(),
    created_at: f.clock.now(),
    updated_at: f.clock.now(),
  });
  expect(logs.find((row) => row.channel === 'push')).toMatchObject({
    app_id: f.app_id,
    user_id: f.user_id,
    code: f.input.code,
    dedupe_key: `${f.input.eventKey}:push`,
    status,
    suppress_reason: status === 'suppressed' ? 'push_disabled' : null,
    sent_at: status === 'success' ? f.clock.now() : null,
    planned_at: f.clock.now(),
    created_at: f.clock.now(),
    updated_at: f.clock.now(),
  });
  return inbox[0]!;
}

it.each(categories.flatMap((category) => combinations.map((settings) => ({ category, settings }))))(
  '[AC-B1-12o#2] $category 只受对应分类开关影响：$settings，关闭仍写站内信',
  async ({ category, settings }) => {
    const f = await fixture(db);
    await f.registration();
    await f.template(category);
    await f.settings(settings);
    // Deliberately disagree with the template: stored category must win.
    await f.send({ category: category === 'service' ? 'marketing' : 'service' });
    const enabled = settings[`${category}_push`];
    expect(f.channel.send).toHaveBeenCalledTimes(enabled ? 1 : 0);
    await assertRecords(f, enabled ? 'success' : 'suppressed');
  },
);

it.each(categories)(
  '[AC-B1-12o#3] %s 无设置行默认开；无模板使用调用方登记分类且不写设置',
  async (category) => {
    const f = await fixture(db);
    const registration = await f.registration();
    await f.send({ category });
    expect(f.channel.send).toHaveBeenCalledTimes(1);
    expect(f.channel.send.mock.calls[0]![0]).toEqual([
      { provider: 'mobpush', token: registration.token },
    ]);
    await assertRecords(f, 'success');
    expect(
      await db
        .selectFrom('notification_settings')
        .selectAll()
        .where('app_id', '=', f.app_id)
        .execute(),
    ).toEqual([]);
  },
);

it.each(categories)('[AC-B1-12o#4] 无模板时 %s 登记分类的关闭开关仍生效', async (category) => {
  const f = await fixture(db);
  await f.registration();
  await f.settings({ ...ON, [`${category}_push`]: false });
  await f.send({ category });
  expect(f.channel.send).not.toHaveBeenCalled();
  await assertRecords(f, 'suppressed');
});

it('[AC-B1-12o#5] 模板查询限定 app/code/variant，不借用其他变体或其他应用分类', async () => {
  const f = await fixture(db);
  await f.registration();
  await f.settings({ ...ON, marketing_push: false });
  await f.template('marketing', f.app_id, 'other');
  await f.template('marketing', `${f.app_id}-other`);
  await db
    .insertInto('notify_templates')
    .values({
      app_id: f.app_id,
      code: 'OTHER_NOTICE',
      category: 'marketing',
      channels: ['inbox', 'push'],
    })
    .execute();
  await f.send();
  expect(f.channel.send).toHaveBeenCalledTimes(1);
  await assertRecords(f, 'success');
});

it('[AC-B1-12o#6] 设置同时按应用及收件人隔离，他人的关闭设置不影响默认开', async () => {
  const f = await fixture(db);
  await f.registration();
  const otherUser = await seedUser(db, f.app_id);
  await f.settings(OFF, { app_id: f.app_id, user_id: otherUser });
  const otherApp = `${f.app_id}-other`;
  await f.settings(OFF, { app_id: otherApp, user_id: await seedUser(db, otherApp) });
  await f.send();
  expect(f.channel.send).toHaveBeenCalledTimes(1);
  await assertRecords(f, 'success');
});

it('[AC-B1-12o#7] 推送载荷精确为站内信编号、标题、正文，发送前事务内已有站内信和成功日志', async () => {
  const f = await fixture(db);
  await f.registration();
  const core = createPushSendCore({
    clock: f.clock,
    channel: f.channel,
    sessionValidity: f.sessionValidity,
  });
  await db.transaction().execute(async (trx) => {
    f.channel.send.mockImplementation(async (_targets, payload) => {
      const inbox = await trx
        .selectFrom('inbox_messages')
        .selectAll()
        .where('app_id', '=', f.app_id)
        .where('user_id', '=', f.user_id)
        .execute();
      const logs = await trx
        .selectFrom('notify_logs')
        .selectAll()
        .where('app_id', '=', f.app_id)
        .where('dedupe_key', '=', f.input.eventKey)
        .execute();
      expect(inbox).toHaveLength(1);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ channel: 'inbox', status: 'success' });
      expect(payload).toEqual({
        message_id: inbox[0]!.message_id,
        title: f.input.title,
        body: f.input.body,
      });
      expect(inbox[0]!.route).toEqual(f.input.route);
      return { status: 'accepted' };
    });
    await core.send(trx, f.input);
  });
  const message = await assertRecords(f, 'success');
  expect(f.channel.send).toHaveBeenCalledTimes(1);
  expect(f.channel.send.mock.calls[0]![1]).toEqual({
    message_id: message.message_id,
    title: f.input.title,
    body: f.input.body,
  });
});

it('[AC-B1-12o#8] 收件人多设备都发送；非本人、其他应用与未绑定行不发送也不改动', async () => {
  const f = await fixture(db);
  const a = await f.registration();
  const b = await f.registration();
  const otherUser = await seedUser(db, f.app_id);
  const foreignApp = `${f.app_id}-other`;
  const foreignUser = await seedUser(db, foreignApp);
  const decoys = [
    await f.registration({ user_id: otherUser }),
    await f.registration({ user_id: null, bound_sid: null }),
    await f.registration({ app_id: foreignApp, user_id: foreignUser }),
  ];
  const before = await db
    .selectFrom('push_tokens')
    .selectAll()
    .where(
      'id',
      'in',
      decoys.map((r) => r.id),
    )
    .orderBy('id')
    .execute();
  await f.send();
  expect(f.channel.send).toHaveBeenCalledTimes(1);
  const [targets] = f.channel.send.mock.calls[0]!;
  expect(targets).toHaveLength(2);
  expect(targets).toEqual(
    expect.arrayContaining([a, b].map((r) => ({ provider: r.provider, token: r.token }))),
  );
  expect(f.sessionValidity).toHaveBeenCalled();
  for (const [, query] of f.sessionValidity.mock.calls) {
    expect(query.app_id).toBe(f.app_id);
    expect(query.user_id).toBe(f.user_id);
    expect(query.sids.every((sid) => [a.bound_sid, b.bound_sid].includes(sid))).toBe(true);
  }
  expect(
    await db
      .selectFrom('push_tokens')
      .selectAll()
      .where(
        'id',
        'in',
        decoys.map((r) => r.id),
      )
      .orderBy('id')
      .execute(),
  ).toEqual(before);
  await assertRecords(f, 'success');
});

it.each(['future', 'revoked', 'invalid-session', 'missing-binding'] as const)(
  '[AC-B1-12o#9] %s 令牌不推送，有绑定的无效行条件解绑，站内信保留',
  async (kind) => {
    const f = await fixture(db);
    const row = await f.registration({
      frozen_until: kind === 'future' ? new Date(f.clock.now().getTime() + 1) : null,
      revoked_at: kind === 'revoked' ? f.clock.now() : null,
      ...(kind === 'missing-binding' ? { bound_sid: null } : {}),
    });
    if (kind === 'invalid-session') f.sessionValidity.mockResolvedValue(new Set());
    await f.send();
    expect(f.channel.send).not.toHaveBeenCalled();
    await assertRecords(f, 'failed');
    const after = await f.binding(row.id);
    expect(after.token).toBe(row.token);
    expect(after.revoked_at).toEqual(row.revoked_at);
    expect(after.frozen_until).toEqual(row.frozen_until);
    if (row.bound_sid !== null) {
      expect(after).toMatchObject({
        user_id: null,
        bound_sid: null,
        row_version: 1,
        updated_at: f.clock.now(),
      });
    }
  },
);

it.each([-1, 0, 1])(
  '[AC-B1-12o#10] 冻结边界相对 Clock 为 %s 毫秒，等于此刻可发送',
  async (offset) => {
    const f = await fixture(db);
    await f.registration({ frozen_until: new Date(f.clock.now().getTime() + offset) });
    await f.send();
    expect(f.channel.send).toHaveBeenCalledTimes(offset <= 0 ? 1 : 0);
    await assertRecords(f, offset <= 0 ? 'success' : 'failed');
  },
);

it('[AC-B1-12o#11] 有效与失效设备混合，只推有效设备并清理失效绑定', async () => {
  const f = await fixture(db);
  const good = await f.registration();
  const bad = await f.registration();
  f.sessionValidity.mockResolvedValue(new Set([good.bound_sid!]));
  await f.send();
  expect(f.channel.send).toHaveBeenCalledTimes(1);
  expect(f.channel.send.mock.calls[0]![0]).toEqual([
    { provider: good.provider, token: good.token },
  ]);
  expect(await f.binding(bad.id)).toMatchObject({ user_id: null, bound_sid: null });
  expect(await f.binding(good.id)).toMatchObject({
    user_id: f.user_id,
    bound_sid: good.bound_sid,
    row_version: 0,
  });
  await assertRecords(f, 'success');
});

it.each(['same-user', 'different-user'] as const)(
  '[AC-B1-12o#12] 校验后设备完成新登录（%s），旧校验的条件解绑保留新绑定',
  async (mode) => {
    const f = await fixture(db);
    const row = await f.registration();
    const user_id = mode === 'same-user' ? f.user_id : await seedUser(db, f.app_id);
    f.sessionValidity.mockImplementation(async (executor, query) => {
      expect(query.sids).toContain(row.bound_sid);
      // Deterministic interleaving: replace the binding after the core read, before it cleans up.
      await executor
        .updateTable('push_tokens')
        .set({
          user_id,
          bound_sid: 'session-new-login',
          row_version: 1,
          updated_at: f.clock.now(),
        })
        .where('app_id', '=', f.app_id)
        .where('id', '=', row.id)
        .execute();
      return new Set();
    });
    await f.send();
    expect(f.sessionValidity).toHaveBeenCalled();
    expect(f.channel.send).not.toHaveBeenCalled();
    expect(await f.binding(row.id)).toMatchObject({
      user_id,
      bound_sid: 'session-new-login',
      row_version: 1,
    });
    await assertRecords(f, 'failed');
  },
);

it('[AC-B1-12o#13] 没有令牌记录 failed，不能冒充用户主动关闭', async () => {
  const f = await fixture(db);
  await f.send();
  expect(f.channel.send).not.toHaveBeenCalled();
  await assertRecords(f, 'failed');
});

it('[AC-B1-12o#14] 通道 rejected 记录 failed，不重发，不丢站内信', async () => {
  const f = await fixture(db);
  await f.registration();
  f.channel.send.mockResolvedValue({ status: 'rejected' });
  await f.send();
  expect(f.channel.send).toHaveBeenCalledTimes(1);
  await assertRecords(f, 'failed');
});

it.each(['success', 'failed', 'suppressed'] as const)(
  '[AC-B1-12o#15] 相同事件重复调用（%s）只有一封站内信和每通道一条日志',
  async (status) => {
    const f = await fixture(db);
    await f.registration();
    if (status === 'failed') f.channel.send.mockResolvedValue({ status: 'rejected' });
    if (status === 'suppressed') await f.settings(OFF);
    await f.send();
    const before = await f.rows();
    // Recreate the service: deduplication must survive an application instance restart.
    await f.send();
    expect(await f.rows()).toEqual(before);
    expect(f.channel.send).toHaveBeenCalledTimes(status === 'suppressed' ? 0 : 1);
    await assertRecords(f, status);
  },
);

it('[AC-B1-12o#16] 同一事件并发两个事务，数据库唯一键保证只推一次', async () => {
  const f = await fixture(db);
  await f.registration();
  await Promise.all([f.send(), f.send()]);
  expect(f.channel.send).toHaveBeenCalledTimes(1);
  await assertRecords(f, 'success');
});

it('[AC-B1-12o#17] 不同应用的相同事件键各自发送，去重不跨 app_id', async () => {
  const a = await fixture(db);
  const b = await fixture(db);
  await a.registration();
  await b.registration();
  await a.send();
  await b.send({ eventKey: a.input.eventKey });
  expect(a.channel.send).toHaveBeenCalledTimes(1);
  expect(b.channel.send).toHaveBeenCalledTimes(1);
  expect((await b.rows()).logs.map((row) => row.dedupe_key).sort()).toEqual(
    [a.input.eventKey, `${a.input.eventKey}:push`].sort(),
  );
  await assertRecords(a, 'success');
});

it('[AC-B1-12o#18] 站内信写入失败时整个事务回滚且不调用通道', async () => {
  const f = await fixture(db);
  await f.registration();
  const failure = new Error('fixture inbox write failure');
  let reached = false;
  const broken = db.withPlugin({
    transformQuery(args) {
      if (
        args.node.kind === 'InsertQueryNode' &&
        args.node.into?.table.identifier.name === 'inbox_messages'
      ) {
        reached = true;
        throw failure;
      }
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  const core = createPushSendCore({
    clock: f.clock,
    channel: f.channel,
    sessionValidity: f.sessionValidity,
  });
  await expect(broken.transaction().execute((trx) => core.send(trx, f.input))).rejects.toBe(
    failure,
  );
  expect(reached).toBe(true);
  expect(await f.rows()).toEqual({ inbox: [], logs: [] });
  expect(f.channel.send).not.toHaveBeenCalled();
});

it('[AC-B1-12o#19] 真实 identity 读口排除吊销和过期会话，仅发送有效绑定', async () => {
  const f = await fixture(db);
  const valid = await seedSession(db, f);
  const revoked = await seedSession(db, f, { revoked_at: f.clock.now() });
  const expired = await seedSession(db, f, { expire_at: f.clock.now() });
  const good = await f.registration({ device_id: valid.device_id, bound_sid: valid.sid });
  const badA = await f.registration({ device_id: revoked.device_id, bound_sid: revoked.sid });
  const badB = await f.registration({ device_id: expired.device_id, bound_sid: expired.sid });
  await f.send({}, createPushSessionValidity(f.clock));
  expect(f.channel.send).toHaveBeenCalledTimes(1);
  expect(f.channel.send.mock.calls[0]![0]).toEqual([
    { provider: good.provider, token: good.token },
  ]);
  for (const row of [badA, badB]) {
    expect(await f.binding(row.id)).toMatchObject({ user_id: null, bound_sid: null });
  }
  await assertRecords(f, 'success');
});

it('[AC-B1-12o#27] 条件解绑同时匹配收件人和旧 sid，不清掉同 sid 的他人行或本人的其他有效会话', async () => {
  const f = await fixture(db);
  const bad = await f.registration();
  const good = await f.registration();
  const someone = await f.registration({
    user_id: await seedUser(db, f.app_id),
    bound_sid: bad.bound_sid,
  });
  const before = await f.binding(someone.id);
  f.sessionValidity.mockResolvedValue(new Set([good.bound_sid!]));
  await f.send();
  expect(await f.binding(bad.id)).toMatchObject({ user_id: null, bound_sid: null });
  expect(await f.binding(someone.id)).toEqual(before);
  expect(await f.binding(good.id)).toMatchObject({
    user_id: f.user_id,
    bound_sid: good.bound_sid,
    row_version: 0,
  });
  expect(f.channel.send).toHaveBeenCalledTimes(1);
  expect(f.channel.send.mock.calls[0]![0]).toEqual([
    { provider: good.provider, token: good.token },
  ]);
  await assertRecords(f, 'success');
});

it('[AC-B1-12o#28] 同一核心发送不同事件时重读分类开关，关闭后下一条只写站内信', async () => {
  const f = await fixture(db);
  await f.registration();
  const core = createPushSendCore({
    clock: f.clock,
    channel: f.channel,
    sessionValidity: f.sessionValidity,
  });
  await db.transaction().execute((trx) => core.send(trx, f.input));
  await f.settings(OFF);
  const nextKey = `${f.input.eventKey}:next`;
  await db.transaction().execute((trx) => core.send(trx, { ...f.input, eventKey: nextKey }));
  const { inbox, logs } = await f.rows();
  expect(inbox).toHaveLength(2);
  expect(new Set(inbox.map((row) => row.message_id)).size).toBe(2);
  expect(logs).toHaveLength(4);
  expect(logs.find((row) => row.dedupe_key === `${f.input.eventKey}:push`)).toMatchObject({
    status: 'success',
  });
  expect(logs.find((row) => row.dedupe_key === nextKey)).toMatchObject({
    channel: 'inbox',
    status: 'success',
  });
  expect(logs.find((row) => row.dedupe_key === `${nextKey}:push`)).toMatchObject({
    channel: 'push',
    status: 'suppressed',
    suppress_reason: 'push_disabled',
    sent_at: null,
  });
  expect(f.channel.send).toHaveBeenCalledTimes(1);
});
