import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { UnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { order } from '../attribution/kit.ts';
import { job } from '../sync/kit.ts';
import { account, at, built, pid, START, user } from '../wiring/db-kit.ts';
import { click } from './db-kit.ts';
import { wired } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  // pdd 行由迁移 0017 种下（key_prefix 'pdd'），直接复用，不再插入（mechanical fixture fix, D10-77）。
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it.each([
  { path: 'fresh', outside: false },
  { path: 'fresh', outside: true },
  { path: 'rerun', outside: false },
  { path: 'rerun', outside: true },
])('[AC-B1-08q#12] 真实 worker $path 回填，窗口外一秒=$outside', async ({ path, outside }) => {
  const a = await account(db);
  const u = await user(db, a.app_id);
  await pid(db, a);
  const linkId = randomUUID();
  const goods = randomUUID();
  await db
    .insertInto('links')
    .values({
      link_id: linkId,
      app_id: a.app_id,
      user_id: u.id,
      platform: 'pdd',
      scene: 'search',
      product_key: `pdd:${goods}`,
      created_at: at('2026-09-29T01:02:03.000Z'),
      updated_at: at('2026-09-29T01:02:03.000Z'),
      expire_at: at('2026-11-01T00:00:00.000Z'),
    })
    .execute();
  const row = await click(db, a.app_id, u.id, {
    link_id: linkId,
    product_key: `pdd:${goods}`,
    created_at: at(outside ? '2026-09-30T15:59:59.000Z' : '2026-10-14T12:13:14.000Z'),
  });
  // 缺 shop_id 键按 B1-08p 为“不适用”，未命中应写 none，而不是留空待补。
  const incoming = order({ raw_status: '0', sub_order_id: randomUUID(), goods_id: goods });
  const f = await wired(db);
  try {
    const r = f.r;
    const listOrders = vi.fn<UnionAdapter['listOrders']>().mockResolvedValue({
      items: [
        path === 'fresh'
          ? incoming
          : {
              ...incoming,
              attr_params: {
                relation_id: null,
                sub_union_id: null,
                custom_parameters: '{"app":"n","uid":"unknown1"}',
              },
            },
      ],
      nextCursor: null,
    });
    // 只替换演示适配器与凭据可查性；来源、归因、更新、数据库读口均为生产装配。
    vi.spyOn(r.access, 'queryableAccount').mockResolvedValue(a.id);
    vi.spyOn(r.registry, 'get').mockReturnValue({ listOrders });
    const registered = f.queue.register.mock.calls.find(([name]) => name === 'order-sync')?.[1];
    expect(typeof registered).toBe('function');
    const win = {
      app_id: a.app_id,
      platform: 'pdd' as const,
      union_account_id: a.id,
      query_kind: 'increment' as const,
      scene: '-' as const,
      window_start: START,
      window_end: '2026-10-17T17:00:00.000Z',
    };
    await built(() => registered!(job(win)));
    const read = () => db.selectFrom('orders').selectAll().where('app_id', '=', a.app_id).execute();
    if (path === 'rerun') {
      expect(await read()).toEqual([
        expect.objectContaining({ user_id: null, source_match: null }),
      ]);
      listOrders.mockResolvedValue({
        items: [
          {
            ...incoming,
            raw_status: '2',
            received_at: at('2026-10-16T03:04:05.000Z'),
            modified_at: at('2026-10-17T08:09:10.000Z'),
            raw_payload_id: '202',
          },
        ],
        nextCursor: null,
      });
      await built(() =>
        registered!(
          job({
            ...win,
            window_start: win.window_end,
            window_end: '2026-10-17T17:30:00.000Z',
          }),
        ),
      );
    }
    expect(await read()).toEqual([
      expect.objectContaining({
        user_id: u.id,
        source_match: outside ? 'none' : 'product',
        link_id: outside ? null : row.link_id,
        source_scene: outside ? null : row.scene,
        agent_session_id: outside ? null : row.agent_session_id,
      }),
    ]);
  } finally {
    await f.context.close();
  }
});
