import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, acquireTestRedis, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createRedisHandle,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { memoryLogger, redisConnection, type TestRedis } from '../../identity/sms-codes/kit.ts';
import { fixture, failure, success, at } from './kit.ts';

// Global setup supplies the migrated template; fixture and application use couli_app.
let database: TestDatabase | undefined;
let server: TestRedis | undefined;
let db: Kysely<DB>;
let redis: RedisHandle;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
  server = await acquireTestRedis();
  redis = (await createRedisHandle(redisConnection(server.url), {
    logger: memoryLogger().logger,
  }))!;
}, 180_000);
afterAll(async () => {
  try {
    await redis?.close();
  } finally {
    try {
      if (db) await destroyDb(db);
    } finally {
      try {
        await database?.drop();
      } finally {
        await server?.stop();
      }
    }
  }
}, 30_000);

it('[AC-B1-10b#8] 子单精确匹配优先父单，删除所有空格并保留前导零', async () => {
  const f = await fixture(db, redis);
  const number = '00' + f.subject.user_id;
  const sub = await f.seed({ sub_order_id: number });
  await f.seed({ parent_order_id: number });
  await f.accepted(' 0 0' + f.subject.user_id + ' ', [sub]);
  expect(await f.items()).toHaveLength(1);
});

it('[AC-B1-10b#9] 子单只命中分享单时继续父单；父单分享单不进入④', async () => {
  const f = await fixture(db, redis);
  const number = f.subject.user_id;
  await f.seed({ sub_order_id: number, buy_type: 'share', user_id: f.subject.user_id });
  const child = await f.seed({ parent_order_id: number });
  await f.seed({
    parent_order_id: number,
    buy_type: 'share',
    user_id: await f.user(),
    attr_at: at('2027-12-01T00:00:00Z'),
    locked: true,
  });
  await f.accepted(number, [child], {}, 'parent');
  expect(await f.count()).toBeNull();
  expect(success(await f.list()).items[0]?.items).toEqual([
    { sub_order_id: child.sub_order_id, decision: null, reject_reason: null },
  ]);
});

it('[AC-B1-10b#10] AC-S1-20 父单全分享、本人分享、他人分享均视为不存在', async () => {
  const f = await fixture(db, redis);
  const parent = 'p-' + f.subject.user_id;
  const own = await f.seed({
    parent_order_id: parent,
    buy_type: 'share',
    user_id: f.subject.user_id,
  });
  const other = await f.seed({
    parent_order_id: parent,
    buy_type: 'share',
    user_id: await f.user(),
  });
  for (const number of [own.sub_order_id, other.sub_order_id, parent]) {
    failure(await f.submit(number), 30201);
  }
  expect(await f.count()).toBe('3');
  expect(await f.items()).toEqual([]);
});

it.each([
  { platform: 'pdd' as const, stored: '12-34--56', input: '123456' },
  { platform: 'pdd' as const, stored: '123456', input: '12-34-56' },
  { platform: 'pdd' as const, stored: '12-34--56', input: '1-2345-6' },
])(
  '[AC-B1-10b#11] 拼多多两侧去全部连字符 $stored / $input；存储与展示原号不变',
  async ({ platform, stored, input }) => {
    const f = await fixture(db, redis);
    const suffix = f.subject.user_id.replaceAll('-', '');
    const row = await f.seed({ platform, sub_order_id: stored + suffix });
    await f.accepted(' ' + input + suffix + ' ', [row], { platform });
    expect(
      (
        await db
          .selectFrom('orders')
          .selectAll()
          .where('order_id', '=', row.order_id)
          .executeTakeFirstOrThrow()
      ).sub_order_id,
    ).toBe(stored + suffix);
  },
);

it('[AC-B1-10b#12] 拼多多父单同样归一化，淘宝和京东不去连字符', async () => {
  const f = await fixture(db, redis);
  const suffix = f.subject.user_id.replaceAll('-', '');
  const pdd = await f.seed({ platform: 'pdd', parent_order_id: '12-34-' + suffix });
  await f.accepted('1234' + suffix, [pdd], { platform: 'pdd' }, 'parent');
  for (const platform of ['taobao', 'jd'] as const) {
    const row = await f.seed({ platform, sub_order_id: '12-34-' + suffix });
    failure(await f.submit('1234' + suffix, { platform }), 30201);
    await f.accepted(row.sub_order_id, [row], { platform });
  }
  expect(await f.count()).toBe('2');
});

it('[AC-B1-10b#13] app_id和platform都是匹配条件，NULL父单不参与', async () => {
  const f = await fixture(db, redis);
  const otherApp = await fixture(db, redis);
  const foreign = await otherApp.seed();
  failure(await f.submit(foreign.sub_order_id), 30201);
  const pdd = await f.seed({ platform: 'pdd' });
  failure(await f.submit(pdd.sub_order_id), 30201);
  await f.seed({ parent_order_id: null });
  failure(await f.submit('null'), 30201);
  expect(await f.count()).toBe('3');
  expect(await f.claims()).toEqual([]);
});

it('[AC-B1-10b#14] 不删制表符/全角空格、不做数字强制转换，精确匹配', async () => {
  const f = await fixture(db, redis);
  const row = await f.seed({ sub_order_id: '00' + f.subject.user_id });
  for (const number of [
    '\t' + row.sub_order_id,
    '　' + row.sub_order_id,
    row.sub_order_id.slice(2),
  ]) {
    failure(await f.submit(number), 30201);
  }
  await f.accepted(row.sub_order_id, [row]);
});

it('[AC-B1-10b#15] share推广位未归因池与仅邀请人分佣不因场景被排除', async () => {
  const f = await fixture(db, redis);
  const linkId = await f.link('jd:i_12345'); // Existing link fixture has scene=share.
  const pool = await f.seed({ link_id: linkId, buy_type: null });
  await f.accepted(pool.sub_order_id, [pool]);
  const self = await f.seed({ user_id: await f.user(), buy_type: 'self', link_id: linkId });
  failure(await f.submit(self.sub_order_id), 30204);
  expect(await f.count()).toBe('1');
});

it('[AC-B1-10b#49] 子单非分享但校验失败不回退父单，空父单不被拼多多空比较值命中', async () => {
  const f = await fixture(db, redis);
  const number = f.subject.user_id;
  await f.seed({ sub_order_id: number, locked: true });
  await f.seed({ parent_order_id: number });
  failure(await f.submit(number), 30204);
  await f.seed({ platform: 'pdd', parent_order_id: null });
  failure(await f.submit('--', { platform: 'pdd' }), 30201);
  expect(await f.items()).toEqual([]);
  expect(await f.count()).toBe('2');
});

it('[AC-B1-10b#50] 同父单跨app和platform只纳入本app、本platform的子单', async () => {
  const f = await fixture(db, redis);
  const foreign = await fixture(db, redis);
  const number = 'P' + f.subject.user_id;
  const own = await f.seed({ parent_order_id: number });
  await foreign.seed({ parent_order_id: number });
  await f.seed({ parent_order_id: number, platform: 'pdd' });
  await f.accepted(number, [own], {}, 'parent');
  expect(await f.items()).toHaveLength(1);
});
