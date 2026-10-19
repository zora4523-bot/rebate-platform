import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, acquireTestRedis, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createClaimEvidenceReader } from '../../../../apps/api/src/modules/linking/index.ts';
import {
  createRedisHandle,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { memoryLogger, redisConnection, type TestRedis } from '../../identity/sms-codes/kit.ts';
import { at, ATTR, value, capture } from '../claims-submit/kit.ts';
import { fixture } from './db-kit.ts';

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

it('[AC-B1-10c#37] linking原始日志读口隔离App/本人/平台，闭区间、不缓存、不提前按业务规则过滤', async () => {
  const f = await fixture(db, redis);
  const other = await f.user();
  const otherApp = `${f.subject.app_id}_other`;
  const otherAppUser = await f.user(otherApp);
  const scope = {
    appId: f.subject.app_id,
    userId: f.subject.user_id,
    platform: 'taobao',
    from: at('2027-12-30T16:10:00.000Z'),
    to: at(ATTR),
  };
  const reader = await value(() => createClaimEvidenceReader(db));
  expect(await value(() => reader.linkLogs(scope))).toEqual([]);
  const first = await f.log({
    created_at: scope.from,
    event: 'register',
    result_code: 30151,
    no_rebate: true,
    no_rebate_reason: 'relation_conflict',
  });
  const last = await f.log({
    created_at: scope.to,
    cache_hit: true,
    expired: true,
    pid_scene: 'share',
  });
  await f.log({ user_id: other, opener_user_id: f.subject.user_id });
  await f.log({ app_id: otherApp, user_id: otherAppUser });
  await f.log({ platform: 'pdd' });
  await f.log({ created_at: at('2027-12-30T16:09:59.999Z') });
  await f.log({ created_at: at('2028-01-14T16:10:00.001Z') });
  const rows = await value(() => reader.linkLogs(scope));
  expect(rows.map((r) => String(r.id)).sort()).toEqual([String(first.id), String(last.id)].sort());
  expect(rows.find((r) => String(r.id) === String(first.id))).toMatchObject({
    event: 'register',
    result_code: 30151,
    no_rebate: true,
    no_rebate_reason: 'relation_conflict',
    app_id: f.subject.app_id,
    user_id: f.subject.user_id,
    platform: 'taobao',
    created_at: scope.from,
  });
  expect(rows.find((r) => String(r.id) === String(last.id))).toMatchObject({
    cache_hit: true,
    expired: true,
    pid_scene: 'share',
  });
});

it('[AC-B1-10c#38] 同一事务连接读取未提交日志、绑定及已解决冲突，回滚后均不可见', async () => {
  const f = await fixture(db, redis);
  const scope = {
    appId: f.subject.app_id,
    userId: f.subject.user_id,
    platform: 'taobao',
    from: at('2027-12-30T16:10:00.000Z'),
    to: at(ATTR),
  };
  const rollback = new Error('synthetic rollback');
  const outcome = await capture(() =>
    db.transaction().execute(async (trx) => {
      // Reuse the subject rather than constructing a new applicant in the transaction.
      const log = await trx
        .insertInto('link_logs')
        .values({
          ...f.subject,
          platform: 'taobao',
          event: 'open',
          result_code: 0,
          created_at: at('2028-01-12T00:00:00.000Z'),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const account = await f.binding({ status: 'invalid' });
      // This uncommitted change distinguishes the transaction from a separate pooled reader.
      await trx
        .updateTable('union_bindings')
        .set({ status: 'active' })
        .where('id', '=', account.id)
        .execute();
      const conflict = await f.conflict();
      await trx
        .updateTable('union_binding_conflicts')
        .set({ resolved_at: at(ATTR), resolution: 'bound_active' })
        .where('id', '=', conflict.id)
        .execute();
      const reader = await value(() => createClaimEvidenceReader(trx));
      expect((await value(() => reader.linkLogs(scope))).map((r) => String(r.id))).toEqual([
        String(log.id),
      ]);
      expect(await value(() => reader.bindings(scope))).toEqual([
        expect.objectContaining({
          status: 'active',
          bound_at: account.bound_at,
          released_at: null,
        }),
      ]);
      expect(await value(() => reader.conflicts(scope))).toEqual([
        expect.objectContaining({ occurred_at: conflict.occurred_at, resolved_at: at(ATTR) }),
      ]);
      throw rollback;
    }),
  );
  expect(outcome).toEqual({ ok: false, error: rollback });
  const reader = await value(() => createClaimEvidenceReader(db));
  expect(await reader.linkLogs(scope)).toEqual([]);
  expect(await reader.bindings(scope)).toEqual([expect.objectContaining({ status: 'invalid' })]);
  expect(await reader.conflicts(scope)).toEqual([expect.objectContaining({ resolved_at: null })]);
});
