import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, acquireTestRedis, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createRedisHandle,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { memoryLogger, redisConnection, type TestRedis } from '../../identity/sms-codes/kit.ts';
import { withHttp, answer } from '../claims-submit/http-kit.ts';
import { PAID, ATTR, at } from '../claims-submit/kit.ts';
import { fixture, persisted } from './db-kit.ts';

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

it.each([
  ['taobao', 'auth_declined', 'active', 'absent', 'strong'],
  ['taobao', 'auth_failed', 'active', 'resolved-before', 'strong'],
  ['taobao', 'auth_failed', 'active', 'resolved-at', 'strong'],
  ['taobao', 'auth_failed', 'active', 'occurred-after', 'strong'],
  ['taobao', 'auth_failed', 'active', 'unresolved', 'none'],
  ['taobao', 'auth_failed', 'active', 'resolved-after', 'none'],
  ['taobao', 'auth_declined', 'absent', 'absent', 'none'],
  ['taobao', 'auth_declined', 'blocked', 'absent', 'none'],
  ['taobao', 'relation_conflict', 'active', 'resolved-before', 'none'],
  ['taobao', 'binding_blocked', 'active', 'absent', 'none'],
  ['pdd', 'auth_failed', 'active', 'absent', 'strong'],
] as const)(
  '[AC-B1-10c#34] 真实授权读口：%s/%s/%s/%s → %s',
  async (platform, reason, binding, conflict, level) => {
    const f = await fixture(db, redis);
    const product_key = platform === 'taobao' ? 'tb:123' : 'pdd:123';
    const row = await f.seed({ platform, product_key });
    const hit = await f.log({ platform, product_key, no_rebate: true, no_rebate_reason: reason });
    // Active Taobao deliberately has no relation_id: this task only requires active.
    if (binding !== 'absent') await f.binding({ platform, status: binding });
    if (conflict !== 'absent') {
      const resolved_at =
        conflict === 'resolved-before'
          ? at('2028-01-14T16:09:59.999Z')
          : conflict === 'resolved-at'
            ? at(ATTR)
            : conflict === 'resolved-after'
              ? at('2028-01-15T02:00:00.000Z')
              : null;
      await f.conflict({
        platform,
        occurred_at: at(
          conflict === 'occurred-after' ? '2028-01-14T16:10:00.001Z' : '2028-01-14T12:00:00.000Z',
        ),
        resolved_at,
        resolution: resolved_at === null ? null : 'bound_active',
      });
    }
    const before = await db
      .selectFrom('link_logs')
      .selectAll()
      .where('app_id', '=', f.subject.app_id)
      .execute();
    await withHttp(
      { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
      async (send) => {
        await answer(await send({ platform, order_no: row.sub_order_id, paid_date: PAID }), 0);
        await persisted(f, [level], [level === 'strong' ? [String(hit.id)] : []]);
        expect(
          await db
            .selectFrom('link_logs')
            .selectAll()
            .where('app_id', '=', f.subject.app_id)
            .execute(),
        ).toEqual(before);
      },
    );
  },
  30_000,
);

it.each(['user', 'app', 'platform'] as const)(
  '[AC-B1-10c#35] 其他%s的active绑定不能授权申请人的无返利记录',
  async (dimension) => {
    const f = await fixture(db, redis);
    const row = await f.seed();
    await f.log({ no_rebate: true, no_rebate_reason: 'auth_failed' });
    const app_id = dimension === 'app' ? `${f.subject.app_id}_other` : f.subject.app_id;
    const user_id = dimension === 'platform' ? f.subject.user_id : await f.user(app_id);
    await f.binding({ app_id, user_id, platform: dimension === 'platform' ? 'pdd' : 'taobao' });
    await withHttp(
      { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
      async (send) => {
        await answer(
          await send({ platform: 'taobao', order_no: row.sub_order_id, paid_date: PAID }),
          0,
        );
        await persisted(f, ['none'], [[]]);
      },
    );
  },
  30_000,
);

it.each(['user', 'app', 'platform'] as const)(
  '[AC-B1-10c#36] 其他%s未解决冲突不能污染本申请人',
  async (dimension) => {
    const f = await fixture(db, redis);
    const row = await f.seed();
    const hit = await f.log({ no_rebate: true, no_rebate_reason: 'auth_failed' });
    await f.binding();
    const app_id = dimension === 'app' ? `${f.subject.app_id}_other` : f.subject.app_id;
    const user_id = dimension === 'platform' ? f.subject.user_id : await f.user(app_id);
    await f.conflict({ app_id, user_id, platform: dimension === 'platform' ? 'pdd' : 'taobao' });
    await withHttp(
      { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
      async (send) => {
        await answer(
          await send({ platform: 'taobao', order_no: row.sub_order_id, paid_date: PAID }),
          0,
        );
        await persisted(f, ['strong'], [[String(hit.id)]]);
      },
    );
  },
  30_000,
);
