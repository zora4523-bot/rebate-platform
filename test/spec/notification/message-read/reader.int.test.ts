// B1-12d · notification's message reader over real PostgreSQL (BR-ID-10 细则「推送点击的落点」;
// 编排者裁定 B1 只返回会话 user_id + app_id 自己的消息, B2 字段与契约, B3 只读, B5 查询带 app_id).
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DB_TIMEOUT,
  closeSuite,
  expectSchema,
  messagesOf,
  newAppId,
  normalised,
  openSuite,
  readerOver,
  seedMessage,
  seedUser,
  type Suite,
} from './kit.ts';

let suite: Suite;
let readonlyDb: Kysely<DB> | undefined;
beforeAll(async () => {
  suite = await openSuite();
  readonlyDb = createDb({ connectionString: suite.database.urlFor('couli_readonly'), max: 2 });
}, 180_000);
afterAll(async () => {
  try {
    if (readonlyDb !== undefined) await destroyDb(readonlyDb);
  } finally {
    await closeSuite(suite);
  }
}, 30_000);

it(
  '[AC-B1-12d#1][BR-ID-10] 自己的未读消息：返回message_id、code、title、body、created_at、read_at=null与route{route,params}，过契约InboxMessage',
  async () => {
    const app = newAppId();
    const uid = await seedUser(suite.db, app);
    const id = await seedMessage(suite.db, {
      app_id: app,
      user_id: uid,
      code: 'WITHDRAW_PAID',
      title: '提现已到账',
      body: '你的提现已到账',
      route: { route: 'WithdrawRecords', params: {} },
      created_at: '2026-10-02T01:30:00.000Z',
    });
    const view = await readerOver(suite.db).get({ app_id: app, user_id: uid, message_id: id });
    expect(normalised(view)).toEqual({
      message_id: id,
      code: 'WITHDRAW_PAID',
      title: '提现已到账',
      body: '你的提现已到账',
      created_at: '2026-10-02T01:30:00.000Z',
      read_at: null,
      route: { route: 'WithdrawRecords', params: {} },
    });
    await expectSchema('data', view);
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12d#2][BR-ID-10] 已读且无跳转的消息：read_at原样返回，route为null；带参数的route原样返回',
  async () => {
    const app = newAppId();
    const uid = await seedUser(suite.db, app);
    const plain = await seedMessage(suite.db, {
      app_id: app,
      user_id: uid,
      code: 'ACCOUNT_NOTICE',
      title: '账号通知',
      body: '这是一条没有跳转的通知',
      route: null,
      read_at: '2026-10-03T08:00:00.000Z',
      created_at: '2026-10-03T07:00:00.000Z',
    });
    const linked = await seedMessage(suite.db, {
      app_id: app,
      user_id: uid,
      code: 'ORDER_SETTLED',
      title: '订单已结算',
      body: '你的一笔订单已结算',
      route: { route: 'OrderDetail', params: { order_id: 'ord-b112d-01', tab: 2 } },
      created_at: '2026-10-04T07:00:00.000Z',
    });
    const reader = readerOver(suite.db);
    const first = await reader.get({ app_id: app, user_id: uid, message_id: plain });
    expect(normalised(first)).toEqual({
      message_id: plain,
      code: 'ACCOUNT_NOTICE',
      title: '账号通知',
      body: '这是一条没有跳转的通知',
      created_at: '2026-10-03T07:00:00.000Z',
      read_at: '2026-10-03T08:00:00.000Z',
      route: null,
    });
    await expectSchema('data', first);
    const second = await reader.get({ app_id: app, user_id: uid, message_id: linked });
    expect(normalised(second)).toEqual({
      message_id: linked,
      code: 'ORDER_SETTLED',
      title: '订单已结算',
      body: '你的一笔订单已结算',
      created_at: '2026-10-04T07:00:00.000Z',
      read_at: null,
      route: { route: 'OrderDetail', params: { order_id: 'ord-b112d-01', tab: 2 } },
    });
    await expectSchema('data', second);
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12d#3][BR-ID-10] 不存在、同app他人的、跨app的消息一律返回null；本人自己的同时仍可读',
  async () => {
    const app = newAppId();
    const other = newAppId('oth');
    const me = await seedUser(suite.db, app);
    const someone = await seedUser(suite.db, app);
    const foreigner = await seedUser(suite.db, other);
    const mine = await seedMessage(suite.db, { app_id: app, user_id: me });
    const theirs = await seedMessage(suite.db, { app_id: app, user_id: someone });
    const abroad = await seedMessage(suite.db, { app_id: other, user_id: foreigner });
    const reader = readerOver(suite.db);
    // Sanity: each message is readable by its own owner, so the misses below are about ownership.
    expect((await reader.get({ app_id: app, user_id: me, message_id: mine }))?.message_id).toBe(
      mine,
    );
    expect(
      (await reader.get({ app_id: app, user_id: someone, message_id: theirs }))?.message_id,
    ).toBe(theirs);
    expect(
      (await reader.get({ app_id: other, user_id: foreigner, message_id: abroad }))?.message_id,
    ).toBe(abroad);

    expect(await reader.get({ app_id: app, user_id: me, message_id: randomUUID() })).toBeNull();
    expect(await reader.get({ app_id: app, user_id: me, message_id: theirs })).toBeNull();
    expect(await reader.get({ app_id: app, user_id: me, message_id: abroad })).toBeNull();
    // The right owner under the wrong app: every query is scoped by app_id too.
    expect(await reader.get({ app_id: other, user_id: me, message_id: mine })).toBeNull();
    expect(await reader.get({ app_id: app, user_id: foreigner, message_id: abroad })).toBeNull();
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12d#4][BR-ID-10] 长度合法但不是UUID的message_id返回null，不抛数据库错误',
  async () => {
    const app = newAppId();
    const me = await seedUser(suite.db, app);
    const mine = await seedMessage(suite.db, { app_id: app, user_id: me });
    const reader = readerOver(suite.db);
    expect((await reader.get({ app_id: app, user_id: me, message_id: mine }))?.message_id).toBe(
      mine,
    );
    for (const id of [
      'abc',
      'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
      `${mine.slice(0, 35)}g`,
      `${mine}-extra`,
      "0' OR '1'='1",
      'a'.repeat(64),
    ]) {
      await expect(
        reader.get({ app_id: app, user_id: me, message_id: id }),
        id,
      ).resolves.toBeNull();
    }
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12d#5][BR-ID-10] 只读：反复读取未读、已读、他人的消息后，inbox_messages各行完全不变（read_at、row_version、updated_at）',
  async () => {
    const app = newAppId();
    const me = await seedUser(suite.db, app);
    const someone = await seedUser(suite.db, app);
    const unread = await seedMessage(suite.db, { app_id: app, user_id: me });
    const read = await seedMessage(suite.db, {
      app_id: app,
      user_id: me,
      read_at: '2026-10-02T02:00:00.000Z',
    });
    const theirs = await seedMessage(suite.db, { app_id: app, user_id: someone });
    const before = await messagesOf(suite.db, app);
    expect(before).toHaveLength(3);
    const reader = readerOver(suite.db);
    for (let round = 0; round < 2; round += 1) {
      expect((await reader.get({ app_id: app, user_id: me, message_id: unread }))?.read_at).toBe(
        null,
      );
      expect((await reader.get({ app_id: app, user_id: me, message_id: read }))?.message_id).toBe(
        read,
      );
      expect(await reader.get({ app_id: app, user_id: me, message_id: theirs })).toBeNull();
    }
    expect(await messagesOf(suite.db, app)).toEqual(before);
    const row = before.find((each) => each.message_id === unread)!;
    expect(row.read_at).toBeNull();
    expect(row.row_version).toBe(0);
  },
  DB_TIMEOUT,
);

it(
  '[AC-B1-12d#6][BR-ID-10] 只读：经只有SELECT权限的couli_readonly连接读取，结果与业务连接完全一致（不写任何表）',
  async () => {
    const app = newAppId();
    const me = await seedUser(suite.db, app);
    const id = await seedMessage(suite.db, {
      app_id: app,
      user_id: me,
      code: 'WITHDRAW_PAID',
      title: '提现已到账',
      body: '你的提现已到账',
      route: { route: 'WithdrawRecords', params: {} },
      created_at: '2026-10-02T01:30:00.000Z',
    });
    const before = await messagesOf(suite.db, app);
    const view = await readerOver(readonlyDb!).get({ app_id: app, user_id: me, message_id: id });
    expect(normalised(view)).toEqual({
      message_id: id,
      code: 'WITHDRAW_PAID',
      title: '提现已到账',
      body: '你的提现已到账',
      created_at: '2026-10-02T01:30:00.000Z',
      read_at: null,
      route: { route: 'WithdrawRecords', params: {} },
    });
    expect(
      await readerOver(readonlyDb!).get({ app_id: app, user_id: me, message_id: randomUUID() }),
    ).toBeNull();
    expect(await messagesOf(suite.db, app)).toEqual(before);
  },
  DB_TIMEOUT,
);
