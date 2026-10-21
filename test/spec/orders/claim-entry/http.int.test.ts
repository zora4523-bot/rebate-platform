import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOrderQueries } from '../../../../apps/api/src/modules/orders/index.ts';
import { withHttp, type Response } from '../list-detail/http-kit.ts';
import { contract } from '../list-detail/schema-kit.ts';
import { fixture } from './db-kit.ts';
import { ago, HOUR, value } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-10h#102] AC-S1-25② 读口中断让HTTP失败，不能降级成成功false', async () => {
  const f = await fixture(db);
  let fail = false;
  const q = await value(() =>
    createOrderQueries({
      ...f.deps,
      claimEntry: {
        read: async () => {
          if (fail) throw new Error('synthetic reader outage');
          return { logs: [], bindings: [] };
        },
      },
    }),
  );
  await withHttp(q, f.subject, async (send) => {
    expect(data(await send('/v1/orders?scope=self')).claim_entry_pinned).toBe(false);
    fail = true;
    const failed = await send('/v1/orders?scope=self');
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ code: 50001 });
    expect(failed.json()).not.toHaveProperty('data.claim_entry_pinned');
  });
}, 30_000);

function data(response: Response): Schema<'OrderListData'> {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  return (response.json() as { data: Schema<'OrderListData'> }).data;
}

it('[AC-B1-10h#100] AC-S1-25② createHttpApp(api)真实生产装配：空页false、有效外跳true、任意新归属false', async () => {
  const f = await fixture(db);
  // No OrderQueries override: this frozen helper calls real createHttpApp('api') with FixedClock.
  await withHttp(
    undefined,
    f.subject,
    async (send, logs) => {
      const empty = data(await send('/v1/orders?scope=self'));
      expect(empty).toMatchObject({ items: [], claim_entry_pinned: false });
      await f.log();
      const pinned = data(
        await send('/v1/orders?scope=self', { 'x-user-id': 'not-the-token-user' }),
      );
      expect(pinned.claim_entry_pinned).toBe(true);
      expect(data(await send('/v1/orders?scope=share'))).not.toHaveProperty('claim_entry_pinned');
      const order = await f.seed({
        attr_at: ago(HOUR),
        platform: 'jd',
        buy_type: 'share',
        rebate_status: 'VOID',
      });
      const cancelled = data(await send('/v1/orders?scope=self&platform=taobao&q=missing'));
      expect(cancelled).toMatchObject({ items: [], claim_entry_pinned: false });
      expect(JSON.stringify(cancelled)).not.toContain('show_claim_entry');
      for (const line of logs) {
        expect(line).not.toContain(f.subject.user_id);
        expect(line).not.toContain(order.sub_order_id);
        const record = JSON.parse(line) as Record<string, unknown>;
        expect(record).not.toHaveProperty('link_log_id');
        expect(record).not.toHaveProperty('link_log_ids');
      }
      const operation = (await contract()).paths['/v1/orders']!.get!;
      expect(operation.operationId).toBe('listOrders');
      expect([undefined, 'planned']).toContain(operation['x-implementation']);
    },
    { db, dbRead: null, close: async () => undefined },
  );
}, 30_000);

it('[AC-B1-10h#101] AC-S1-25② 真实HTTP带cursor/筛选同值，错误参数仍20001', async () => {
  const f = await fixture(db);
  await f.log();
  for (let i = 0; i < 3; i++) await f.seed();
  await withHttp(
    undefined,
    f.subject,
    async (send) => {
      const first = data(await send('/v1/orders?scope=self&limit=1'));
      expect(first.claim_entry_pinned).toBe(true);
      expect(first.next_cursor).toEqual(expect.any(String));
      for (const query of [
        '&cursor=' + encodeURIComponent(first.next_cursor!) + '&limit=1',
        '&platform=pdd&paid_month=2026-01&q=missing',
        '&display_status=INVALID',
        '&status_group=credited',
      ])
        expect(data(await send('/v1/orders?scope=self' + query)).claim_entry_pinned).toBe(true);
      for (const query of ['cursor=%25bad', 'limit=0', 'limit=51', 'paid_month=2028-99']) {
        const response = await send('/v1/orders?scope=self&' + query);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ code: 20001 });
      }
    },
    { db, dbRead: null, close: async () => undefined },
  );
}, 30_000);
