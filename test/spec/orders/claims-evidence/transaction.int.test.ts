import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, acquireTestRedis, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as linking from '../../../../apps/api/src/modules/linking/index.ts';
import {
  createOrderClaim,
  type ClaimEvidenceFactory,
} from '../../../../apps/api/src/modules/orders/index.ts';
import {
  createOrderClaimIn,
  readClaimSettings,
} from '../../../../apps/api/src/modules/orders/application/order-claims.ts';
import {
  createRedisHandle,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { memoryLogger, redisConnection, type TestRedis } from '../../identity/sms-codes/kit.ts';
import { withHttp, answer } from '../claims-submit/http-kit.ts';
import { at, PAID, ATTR, value, capture } from '../claims-submit/kit.ts';
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

it.each(['linkLogs', 'bindings', 'conflicts', 'deriveProductKey'] as const)(
  '[AC-B1-10c#39] %s读错整事务回滚、50001且不计失败；恢复后可重交',
  async (failedPort) => {
    const f = await fixture(db, redis);
    const row = await f.seed({ product_key: null });
    const hit = await f.log({ no_rebate: true, no_rebate_reason: 'auth_failed' });
    await f.binding();
    await f.setCount(2);
    let fail = true;
    const evidence: ClaimEvidenceFactory = (trx) => {
      const reader = linking.createClaimEvidenceReader(trx);
      const maybeFail = () => {
        if (fail) throw new Error('synthetic evidence read outage');
      };
      return {
        reads: {
          linkLogs: (scope) => {
            if (failedPort === 'linkLogs') maybeFail();
            return reader.linkLogs(scope);
          },
          bindings: (scope) => {
            if (failedPort === 'bindings') maybeFail();
            return reader.bindings(scope);
          },
          conflicts: (scope) => {
            if (failedPort === 'conflicts') maybeFail();
            return reader.conflicts(scope);
          },
        },
        deriveProductKey: async () => {
          if (failedPort === 'deriveProductKey') maybeFail();
          return 'tb:123';
        },
      };
    };
    const submit = () =>
      createOrderClaim({ ...f.deps, evidence }, f.subject, {
        platform: 'taobao',
        order_no: row.sub_order_id,
        paid_date: PAID,
      });
    expect(await value(submit)).toEqual({ code: 50001 });
    expect(await f.claims()).toEqual([]);
    expect(await f.items()).toEqual([]);
    expect(await f.count()).toBe('2');
    fail = false;
    expect(await value(submit)).toMatchObject({ code: 0, data: { status: 'auto_matched' } });
    await persisted(f, ['strong'], [[String(hit.id)]]);
    expect(await f.count()).toBe('2');
  },
);

it('[AC-B1-10c#40] J-5：受理、证据与调用方事务同提交；外层撤销后不留claim或items', async () => {
  const f = await fixture(db, redis);
  const row = await f.seed();
  const hit = await f.log();
  const settings = await readClaimSettings(f.config, f.subject.app_id);
  const abort = new Error('synthetic outer transaction abort');
  const outcome = await capture(() =>
    db.transaction().execute(async (trx) => {
      const evidence: ClaimEvidenceFactory = (connection) => {
        expect(connection).toBe(trx);
        return {
          reads: linking.createClaimEvidenceReader(connection),
          deriveProductKey: async () => null,
        };
      };
      const result = await value(() =>
        createOrderClaimIn(
          trx,
          { ...f.deps, evidence },
          f.subject,
          { platform: 'taobao', order_no: row.sub_order_id, paid_date: PAID },
          settings,
        ),
      );
      expect(result).toMatchObject({ code: 0, data: { status: 'auto_matched' } });
      expect(
        await trx
          .selectFrom('claims')
          .select(['status', 'evidence_level'])
          .where('app_id', '=', f.subject.app_id)
          .execute(),
      ).toEqual([{ status: 'auto_matched', evidence_level: 'strong' }]);
      expect(
        await trx
          .selectFrom('claim_items')
          .select(['evidence', 'evidence_link_log_ids'])
          .where('app_id', '=', f.subject.app_id)
          .execute(),
      ).toEqual([{ evidence: 'strong', evidence_link_log_ids: [hit.id] }]);
      expect(await f.claims()).toEqual([]);
      expect(await f.items()).toEqual([]);
      throw abort;
    }),
  );
  expect(outcome).toEqual({ ok: false, error: abort });
  expect(await f.claims()).toEqual([]);
  expect(await f.items()).toEqual([]);
  expect(await f.count()).toBeNull();
});

it('[AC-B1-10c#41] 配置在事务前读，各子项按申请主体与自己的attr_at传闭区间', async () => {
  const f = await fixture(db, redis);
  const parent = randomUUID();
  await f.seed({ parent_order_id: parent, sub_order_id: 'A' });
  await f.seed({
    parent_order_id: parent,
    sub_order_id: 'B',
    attr_at: at('2028-01-14T17:10:00.000Z'),
  });
  f.settings.set('attr.backfill_window_hours', 24);
  const scopes: unknown[] = [];
  let transactionStarted = false;
  const originalTransaction = db.transaction.bind(db);
  const spy = vi.spyOn(db, 'transaction').mockImplementation(() => {
    transactionStarted = true;
    return originalTransaction();
  });
  const configValue = f.config.configValue;
  f.config.configValue = async (appId, key) => {
    expect(
      transactionStarted,
      'configuration cannot acquire a second connection inside acceptance',
    ).toBe(false);
    return configValue(appId, key);
  };
  const evidence: ClaimEvidenceFactory = (trx) => {
    const reader = linking.createClaimEvidenceReader(trx);
    return {
      reads: {
        ...reader,
        linkLogs: async (scope) => {
          scopes.push(scope);
          return reader.linkLogs(scope);
        },
        bindings: (scope) => reader.bindings(scope),
        conflicts: (scope) => reader.conflicts(scope),
      },
      deriveProductKey: async () => null,
    };
  };
  try {
    const result = await value(() =>
      createOrderClaim({ ...f.deps, evidence }, f.subject, {
        platform: 'taobao',
        order_no: parent,
        paid_date: PAID,
      }),
    );
    expect(result).toMatchObject({ code: 0, data: { status: 'manual_review' } });
    expect(scopes).toEqual(
      expect.arrayContaining([
        {
          appId: f.subject.app_id,
          userId: f.subject.user_id,
          platform: 'taobao',
          from: at('2028-01-13T16:10:00.000Z'),
          to: at(ATTR),
        },
        {
          appId: f.subject.app_id,
          userId: f.subject.user_id,
          platform: 'taobao',
          from: at('2028-01-13T17:10:00.000Z'),
          to: at('2028-01-14T17:10:00.000Z'),
        },
      ]),
    );
    await persisted(f, ['none', 'none'], [[], []]);
  } finally {
    spy.mockRestore();
  }
});

it('[AC-B1-10c#42] HTTP证据读错不存幂等响应；同键恢复后返回终态，只建一次', async () => {
  const f = await fixture(db, redis);
  const row = await f.seed();
  const hit = await f.log();
  const original = linking.createClaimEvidenceReader;
  let fail = true;
  const spy = vi.spyOn(linking, 'createClaimEvidenceReader').mockImplementation((connection) => {
    const reader = original(connection);
    return {
      linkLogs: async (scope) => {
        if (fail) throw new Error('synthetic evidence outage');
        return reader.linkLogs(scope);
      },
      bindings: (scope) => reader.bindings(scope),
      conflicts: (scope) => reader.conflicts(scope),
    };
  });
  try {
    await withHttp(
      { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
      async (send) => {
        const key = randomUUID();
        const payload = { platform: 'taobao', order_no: row.sub_order_id, paid_date: PAID };
        await answer(await send(payload, { key }), 50001);
        expect(await f.claims()).toEqual([]);
        expect(await f.items()).toEqual([]);
        expect(await f.count()).toBeNull();
        fail = false;
        const response = await send(payload, { key });
        await answer(response, 0);
        expect(response.json().data).toMatchObject({ status: 'auto_matched' });
        await persisted(f, ['strong'], [[String(hit.id)]]);
        expect((await send(payload, { key })).body).toBe(response.body);
        expect(await f.claims()).toHaveLength(1);
      },
    );
  } finally {
    spy.mockRestore();
  }
}, 30_000);
