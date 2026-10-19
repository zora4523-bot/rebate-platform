import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { traceQueries } from '../attribution/kit.ts';
import { at, built, user } from '../wiring/db-kit.ts';
import { click } from './db-kit.ts';
import { wired } from './kit.ts';

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

it('[AC-B1-08q#11] 真实 linkLogs 按 App/用户/平台隔离且两端闭，不过滤事件、结果、场景', async () => {
  const app = randomUUID();
  const otherApp = randomUUID();
  const u = await user(db, app);
  const otherUser = await user(db, app, { attr_code: 'other123' });
  const foreignUser = await user(db, otherApp);
  const from = at('2026-10-01T04:05:06.000Z');
  const to = at('2026-10-16T04:05:06.000Z');
  const expected = [
    await click(db, app, u.id, { created_at: from }),
    await click(db, app, u.id, { created_at: to, event: 'convert' }),
    await click(db, app, u.id, { event: 'register', result_code: 30101, pid_scene: null }),
    await click(db, app, u.id, { event: 'precompute', pid_scene: 'agent' }),
    await click(db, app, u.id, { result_code: 30102, pid_scene: 'self_buy' }),
  ];
  await click(db, app, u.id, { created_at: at('2026-10-01T04:05:05.999Z') });
  await click(db, app, u.id, { created_at: at('2026-10-16T04:05:06.001Z') });
  await click(db, otherApp, foreignUser.id);
  await click(db, app, otherUser.id);
  await click(db, app, u.id, { platform: 'jd' });
  const traced = traceQueries(db);
  const f = await wired(traced.db);
  try {
    const read = () =>
      built(() =>
        f.sources.linkLogs({
          appId: app,
          userId: u.id,
          platform: 'pdd',
          from,
          to,
        }),
      );
    const rows = await read();
    expect(rows).toHaveLength(expected.length);
    for (const row of expected) {
      expect(rows).toContainEqual(
        expect.objectContaining({
          id: row.id,
          link_id: row.link_id,
          event: row.event,
          user_id: row.user_id,
          platform: row.platform,
          product_key: row.product_key,
          shop_id: row.shop_id,
          pid_scene: row.pid_scene,
          scene: row.scene,
          agent_session_id: row.agent_session_id,
          result_code: row.result_code,
          created_at: row.created_at,
        }),
      );
    }
    expect(rows.every((row) => typeof row.id === 'bigint')).toBe(true);
    expect(
      await built(() =>
        f.sources.linkLogs({
          appId: otherApp,
          userId: u.id,
          platform: 'pdd',
          from,
          to,
        }),
      ),
    ).toEqual([]);
    const added = await click(db, app, u.id);
    const again = await read();
    expect(again).toHaveLength(expected.length + 1);
    expect(again).toContainEqual(expect.objectContaining({ id: added.id }));
    expect(traced.queries.length).toBeGreaterThanOrEqual(2);
    expect(traced.queries.every((q) => /^select\b/i.test(q.sql))).toBe(true);
  } finally {
    await f.context.close();
  }
});
