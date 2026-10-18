import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { expectSourceWrite, expectWindow, fresh, runFresh } from './db-kit.ts';
import { at } from './kit.ts';

// Clone the template supplied by global setup; query through couli_app.
let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-08j#40] 首次入库按 agent 推广位过滤，较新的自购搜索点击不得覆盖 Agent 来源', async () => {
  const f = await fresh(db);
  f.findPid.mockResolvedValue([{ pid_scene: 'agent', status: 'active', site_id: null }]);
  const agent = { ...f.sources.row, pid_scene: 'agent' };
  const search = {
    ...agent,
    id: agent.id + 1n,
    link_id: randomUUID(),
    pid_scene: 'self_buy',
    scene: 'search',
    agent_session_id: null,
    created_at: at('2026-10-15T08:09:10Z'),
  };
  await f.db
    .updateTable('links')
    .set({ pid_scene: 'agent' })
    .where('app_id', '=', f.ctx.app_id)
    .where('link_id', '=', agent.link_id!)
    .execute();
  await f.db
    .insertInto('links')
    .values({
      app_id: f.ctx.app_id,
      link_id: search.link_id,
      user_id: f.userId,
      platform: f.ctx.platform,
      product_key: search.product_key,
      scene: search.scene,
      pid_scene: search.pid_scene,
      agent_session_id: null,
      expire_at: at('2026-11-02T01:02:03Z'),
      created_at: at('2026-10-13T06:07:08Z'),
      updated_at: at('2026-10-13T08:09:10Z'),
    })
    .execute();
  // Both clicks match the user/product/window; only the older one matches the PID scene.
  f.sources.linkLogs.mockResolvedValue([search, agent]);

  const result = await runFresh(f);
  expect(result).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  expect((await f.read()).orders[0]).toMatchObject({
    source_match: 'product',
    source_scene: 'agent',
    link_id: agent.link_id,
    agent_session_id: agent.agent_session_id,
    user_id: f.userId,
    buy_type: 'self',
    scene_basis: 'pid',
    pay_amount_fen: 12345n,
    est_commission_fen: 789n,
  });
  expectWindow(f, f.sources);
  expectSourceWrite(f.queries, 'insert');
});
