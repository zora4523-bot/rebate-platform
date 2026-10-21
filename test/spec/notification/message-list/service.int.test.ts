// BR-ID-10 and B1-12k ruling B: real business-role PG, no mocked SQL or cursor codec.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createInboxMessages } from '../../../../apps/api/src/modules/notification/application/inbox-messages.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  NOW,
  TIMEOUT,
  expectSchema,
  messagesOf,
  newAppId,
  normalised,
  seedMessage,
  seedUser,
} from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
let readonlyDb: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  readonlyDb = createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 });
}, 180_000);
afterAll(async () => {
  try {
    if (db !== undefined) await destroyDb(db);
    if (readonlyDb !== undefined) await destroyDb(readonlyDb);
  } finally {
    await database?.drop();
  }
}, 30_000);

async function fixture() {
  const app_id = newAppId('list');
  const user_id = await seedUser(db, app_id);
  const someone = await seedUser(db, app_id);
  const otherApp = newAppId('other');
  const abroad = { app_id: otherApp, user_id: await seedUser(db, otherApp) };
  const clock = new FixedClock(NOW);
  return {
    owner: { app_id, user_id },
    someone: { app_id, user_id: someone },
    otherApp,
    abroad,
    clock,
  };
}

it(
  '[AC-B1-12k#1][BR-ID-10] 列表和未读数只含app_id、user_id双匹配，字段与详情相同，读取不改任何行',
  async () => {
    const f = await fixture();
    const unread = await seedMessage(db, f.owner, {
      created_at: '2026-10-03T01:30:00.000Z',
      route: { route: 'OrderDetail', params: { order_id: 'order-b112k', tab: 2 } },
    });
    const read = await seedMessage(db, f.owner, {
      read_at: '2026-10-02T02:00:00.000Z',
      row_version: 7,
    });
    await seedMessage(db, f.someone);
    await seedMessage(db, f.abroad);
    const before = await messagesOf(db, f.owner.app_id);
    const beforeOther = await messagesOf(db, f.otherApp);
    const service = createInboxMessages({ db: readonlyDb, clock: f.clock });
    const page = await service.list(f.owner);
    expect(page.items.map(normalised)).toEqual([
      {
        message_id: unread,
        code: 'WITHDRAW_PAID',
        title: '提现已到账',
        body: '你的提现已到账',
        created_at: '2026-10-03T01:30:00.000Z',
        read_at: null,
        route: { route: 'OrderDetail', params: { order_id: 'order-b112k', tab: 2 } },
      },
      {
        message_id: read,
        code: 'WITHDRAW_PAID',
        title: '提现已到账',
        body: '你的提现已到账',
        created_at: '2026-10-02T01:30:00.000Z',
        read_at: '2026-10-02T02:00:00.000Z',
        route: null,
      },
    ]);
    expect(page.next_cursor).toBeNull();
    await expectSchema('listMessages', 'data', page);
    expect(await service.unreadCount(f.owner)).toEqual({ unread_count: 1 });
    expect(await service.unreadCount(f.someone)).toEqual({ unread_count: 1 });
    // Right user under the wrong app isolates app_id from user_id without violating the FK.
    expect(await service.list({ ...f.owner, app_id: f.otherApp })).toEqual({
      items: [],
      next_cursor: null,
    });
    expect(await service.unreadCount({ ...f.owner, app_id: f.otherApp })).toEqual({
      unread_count: 0,
    });
    expect(await messagesOf(db, f.owner.app_id)).toEqual(before);
    expect(await messagesOf(db, f.otherApp)).toEqual(beforeOther);
  },
  TIMEOUT,
);

it(
  '[AC-B1-12k#2] created_at微秒优先、完全同刻按message_id倒序；多种页长跨页不重不漏，末页无游标',
  async () => {
    const f = await fixture();
    const suffixes = [
      '000000000009',
      '000000000008',
      '00000000000f',
      '000000000001',
      '00000000000a',
    ];
    const stamps = ['123900', '123900', '123800', '123100', '122999'];
    const ids = suffixes.map((tail) => `019a0000-0000-7000-8000-${tail}`);
    // Insert out of order so neither insertion order nor message_id alone passes.
    for (const i of [3, 1, 4, 0, 2]) {
      await seedMessage(db, f.owner, {
        message_id: ids[i]!,
        created_at: `2026-10-03T01:30:00.${stamps[i]}Z`,
      });
    }
    const before = await messagesOf(db, f.owner.app_id);
    const service = createInboxMessages({ db, clock: f.clock });
    for (const limit of [1, 2, 3, 5]) {
      let cursor: string | undefined;
      const seen: string[] = [];
      for (let pageNumber = 0; pageNumber < ids.length; pageNumber += 1) {
        const page = await service.list({
          ...f.owner,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(page.items.map((item) => item.message_id)).toEqual(
          ids.slice(seen.length, seen.length + limit),
        );
        await expectSchema('listMessages', 'data', page);
        seen.push(...page.items.map((item) => item.message_id));
        if (seen.length === ids.length) {
          expect(page.next_cursor).toBeNull();
          break;
        }
        expect(page.next_cursor).toEqual(expect.any(String));
        expect(page.next_cursor).not.toBe('');
        cursor = page.next_cursor!;
      }
      expect(seen).toEqual(ids);
    }
    expect(await messagesOf(db, f.owner.app_id)).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B1-12k#3] 默认20、上限50；空账号为空列表、null游标和零未读',
  async () => {
    const f = await fixture();
    const ids: string[] = [];
    for (let i = 0; i < 51; i += 1) ids.push(await seedMessage(db, f.owner));
    ids.sort().reverse();
    const service = createInboxMessages({ db, clock: f.clock });
    const first = await service.list(f.owner);
    expect(first.items.map((item) => item.message_id)).toEqual(ids.slice(0, 20));
    expect(first.next_cursor).toEqual(expect.any(String));
    const largest = await service.list({ ...f.owner, limit: 50 });
    expect(largest.items.map((item) => item.message_id)).toEqual(ids.slice(0, 50));
    expect(largest.next_cursor).toEqual(expect.any(String));
    const last = await service.list({ ...f.owner, limit: 50, cursor: largest.next_cursor! });
    expect(last.items.map((item) => item.message_id)).toEqual(ids.slice(50));
    expect(last.next_cursor).toBeNull();
    expect(await service.list(f.someone)).toEqual({ items: [], next_cursor: null });
    expect(await service.unreadCount(f.someone)).toEqual({ unread_count: 0 });
    await expectSchema('listMessages', 'data', largest);
    await expectSchema('getUnreadMessageCount', 'data', await service.unreadCount(f.owner));
  },
  TIMEOUT,
);

it(
  '[AC-B1-12k#4][BR-ID-10] 指定id只改本人未读；重复、未知、他人的跳过，已读原值及其余列不变',
  async () => {
    const f = await fixture();
    const target = await seedMessage(db, f.owner, { row_version: 9 });
    const remaining = await seedMessage(db, f.owner);
    const read = await seedMessage(db, f.owner, {
      read_at: '2026-10-02T02:00:00.123456Z',
      row_version: 4,
    });
    const theirs = await seedMessage(db, f.someone);
    const abroad = await seedMessage(db, f.abroad);
    const before = await messagesOf(db, f.owner.app_id);
    const beforeOther = await messagesOf(db, f.otherApp);
    const service = createInboxMessages({ db, clock: f.clock });
    const command = {
      ...f.owner,
      message_ids: [target, target, read, theirs, abroad, randomUUID(), 'non-uuid-id'],
    };
    const exactRead = () =>
      db
        .withSchema('app')
        .selectFrom('inbox_messages')
        .select(sql<string>`read_at::text`.as('read_at'))
        .where('message_id', '=', read)
        .executeTakeFirstOrThrow();
    const originalRead = await exactRead();
    expect(await service.markRead({ ...command, app_id: f.otherApp })).toEqual({
      marked_count: 0,
      unread_count: 0,
    });
    expect(await messagesOf(db, f.owner.app_id)).toEqual(before);
    const result = await service.markRead(command);
    expect(result).toEqual({ marked_count: 1, unread_count: 1 });
    await expectSchema('markMessagesRead', 'data', result);
    expect(await service.unreadCount(f.owner)).toEqual({ unread_count: result.unread_count });
    const after = await messagesOf(db, f.owner.app_id);
    expect(after).toEqual(
      before.map((row) =>
        row.message_id === target
          ? { ...row, read_at: f.clock.now(), updated_at: f.clock.now(), row_version: 10 }
          : row,
      ),
    );
    expect(after.find((row) => row.message_id === remaining)?.read_at).toBeNull();
    expect(await messagesOf(db, f.otherApp)).toEqual(beforeOther);
    f.clock.advanceMs(60_000);
    expect(await service.markRead(command)).toEqual({ marked_count: 0, unread_count: 1 });
    expect(await messagesOf(db, f.owner.app_id)).toEqual(after);
    expect(await exactRead()).toEqual(originalRead);
  },
  TIMEOUT,
);

it(
  '[AC-B1-12k#5][BR-ID-10] all=true越过100条限制标全部本人未读；不同app与他人不动，再次调用标零条',
  async () => {
    const f = await fixture();
    for (let i = 0; i < 101; i += 1) await seedMessage(db, f.owner);
    const read = await seedMessage(db, f.owner, {
      read_at: '2026-10-02T02:00:00.000Z',
      row_version: 3,
    });
    await seedMessage(db, f.someone);
    await seedMessage(db, f.abroad);
    const before = await messagesOf(db, f.owner.app_id);
    const beforeOther = await messagesOf(db, f.otherApp);
    const service = createInboxMessages({ db, clock: f.clock });
    expect(await service.markRead({ ...f.owner, app_id: f.otherApp, all: true })).toEqual({
      marked_count: 0,
      unread_count: 0,
    });
    expect(await messagesOf(db, f.owner.app_id)).toEqual(before);
    expect(await service.markRead({ ...f.owner, all: true })).toEqual({
      marked_count: 101,
      unread_count: 0,
    });
    const after = await messagesOf(db, f.owner.app_id);
    expect(after).toEqual(
      before.map((row) =>
        row.user_id === f.owner.user_id && row.message_id !== read
          ? {
              ...row,
              read_at: f.clock.now(),
              updated_at: f.clock.now(),
              row_version: row.row_version + 1,
            }
          : row,
      ),
    );
    expect(await messagesOf(db, f.otherApp)).toEqual(beforeOther);
    expect(await service.unreadCount(f.owner)).toEqual({ unread_count: 0 });
    expect(await service.unreadCount(f.someone)).toEqual({ unread_count: 1 });
    f.clock.advanceMs(120_000);
    expect(await service.markRead({ ...f.owner, all: true })).toEqual({
      marked_count: 0,
      unread_count: 0,
    });
    expect(await messagesOf(db, f.owner.app_id)).toEqual(after);
    const empty = { app_id: f.owner.app_id, user_id: await seedUser(db, f.owner.app_id) };
    expect(await service.markRead({ ...empty, all: true })).toEqual({
      marked_count: 0,
      unread_count: 0,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-12k#6] 并发重复标同一消息合计只计一次，read_at与row_version只更新一次',
  async () => {
    const f = await fixture();
    const id = await seedMessage(db, f.owner, { row_version: 5 });
    const service = createInboxMessages({ db, clock: f.clock });
    const results = await Promise.all([
      service.markRead({ ...f.owner, message_ids: [id] }),
      service.markRead({ ...f.owner, message_ids: [id] }),
    ]);
    expect(results.map((result) => result.marked_count).sort()).toEqual([0, 1]);
    expect(results.map((result) => result.unread_count)).toEqual([0, 0]);
    expect(await messagesOf(db, f.owner.app_id)).toMatchObject([
      { message_id: id, read_at: f.clock.now(), updated_at: f.clock.now(), row_version: 6 },
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-12k#14][BR-ID-10] 游标绑定app_id与user_id，换其中任一项均拒绝且不改消息',
  async () => {
    const f = await fixture();
    await seedMessage(db, f.owner);
    await seedMessage(db, f.owner);
    const before = await messagesOf(db, f.owner.app_id);
    const service = createInboxMessages({ db, clock: f.clock });
    const first = await service.list({ ...f.owner, limit: 1 });
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(first.next_cursor).not.toBe('');
    const cursor = first.next_cursor!;
    const next = await service.list({ ...f.owner, cursor });
    expect(next.items).toHaveLength(1);
    expect(next.items[0]!.message_id).not.toBe(first.items[0]!.message_id);
    // Transport error code/fields are tested over HTTP (#10); the application port rejects.
    await expect(service.list({ ...f.owner, app_id: f.otherApp, cursor })).rejects.toBeInstanceOf(
      Error,
    );
    await expect(service.list({ ...f.someone, cursor })).rejects.toBeInstanceOf(Error);
    expect(await messagesOf(db, f.owner.app_id)).toEqual(before);
  },
  TIMEOUT,
);
