// B1-06zd rule tests: the Agent's registration path (D10-510). A quote on the stream entry reads the
// product detail, so its link gets a prefetch job although the row says entry_source 'agent'; the
// cards of an Agent search get none. The real stream entry and its running JOB_QUEUE.
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { APP } from '../../agent/stream-assembly/kit.ts';
import { callTool } from '../../agent/stream-assembly/regression-kit.ts';
import { framesOf, message, openSession, send, type Row } from '../../agent/stream-mount/kit.ts';
import { agentEntry } from './agent-kit.ts';
import { QUEUE_NAME, expectJobsFor, jobsOf } from './kit.ts';

let database: TestDatabase;
let redis: TestRedis;
let db: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await destroyDb(db);
  await database.drop();
  await redis.stop();
}, 60_000);

it('[AC-B1-06zd#48] Agent 报价：stream 入口的 get_rebate_quote 取详情登记的淘宝 link 投一个任务（entry_source 是 agent），同一 App 里 Agent 搜索卡不投，登记不调联盟', async () => {
  const convert = vi.spyOn(DemoUnionAdapter.prototype, 'convert');
  const r = await agentEntry(db, { database: database.urlFor('couli_app'), redis: redis.url });
  try {
    const sessionId = await openSession(r, r.caller);
    const frames = framesOf((await send(r, r.caller, sessionId, message('演示商品'))).chunks);
    const lists = frames.filter(
      (frame) => frame.event === 'card' && frame.data['type'] === 'product_list',
    );
    expect(lists).toHaveLength(1);
    const items = (lists[0]!.data['data'] as Row)['items'] as Row[];
    expect(items.length).toBeGreaterThan(0);
    const productKey = items[0]!['product_key'] as string;
    expect(productKey).toBeTypeOf('string');

    const ctx = { ...r.context(sessionId), context: { product_key: productKey } };
    const outcome = await callTool(r.body.tools, ctx, 'get_rebate_quote', {
      product_key: productKey,
    });

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    const card = outcome.cards.find((entry) => entry.type === 'rebate_quote');
    expect(card).toBeDefined();
    const product = card!.data['product'] as Row;
    expect(product['rebate_basis']).not.toBe('no_rebate');
    const linkId = product['link_id'] as string;
    expect(linkId).toBeTypeOf('string');
    expect(items.map((item) => item['link_id'])).not.toContain(linkId);
    const row = await db
      .selectFrom('links')
      .selectAll()
      .where('link_id', '=', linkId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      app_id: APP,
      platform: 'taobao',
      scene: 'agent',
      entry_source: 'agent',
      user_id: r.caller.userId,
      promo_url: null,
      identity_snapshot: { user_id: r.caller.userId, relation_id: r.relationId },
    });

    const jobs = await expectJobsFor({ jobs: (appId) => jobsOf(db, appId) }, APP, [linkId]);
    expect(jobs[0]).toMatchObject({ queue: QUEUE_NAME });
    expect(jobs[0]!.payload).toEqual({ app_id: APP, link_id: linkId });
    expect(convert).not.toHaveBeenCalled();
  } finally {
    await r.app.close();
  }
}, 120_000);
