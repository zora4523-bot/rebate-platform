import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { TestIdentity } from '../pdd-convert/kit.ts';
import { envelope, row as goodsRow } from '../pdd-goods/kit.ts';
import { harness, outcome, rows } from './kit.ts';
import { assemble } from './wiring-kit.ts';

// Credential loading belongs to B1-04t; no real files/accounts are opened here.
vi.mock('../../../../apps/api/src/modules/platform/config/pdd-startup.ts', async (original) => ({
  ...(await original<
    typeof import('../../../../apps/api/src/modules/platform/config/pdd-startup.ts')
  >()),
  openPddCredentials: vi.fn(async () => async () => ({
    clientId: 'fake-client',
    clientSecret: 'fake-pass!',
  })),
}));

let database: TestDatabase;
let db: Kysely<DB>;
let reader: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app') });
  reader = createDb({ connectionString: database.urlFor('couli_readonly') });
});
afterAll(async () => {
  if (reader) await destroyDb(reader);
  if (db) await destroyDb(db);
  if (database) await database.drop();
});
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => expect.fail('network access is forbidden')),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('[AC-B1-04p-WIRING#1] staging pdd live 的 HTTPS 装配在一次商品调用后提交一行；demo 装配无归档', async () => {
  const h = harness(db);
  const accountId = randomUUID();
  await db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: h.appId,
      platform: 'pdd',
      account_name: 'synthetic account',
      status: 'active',
      auth_status: 'active',
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
    })
    .execute();
  await db
    .insertInto('union_pids')
    .values({
      id: randomUUID(),
      app_id: h.appId,
      platform: 'pdd',
      union_account_id: accountId,
      pid: 'fake-query-pid',
      pid_scene: 'query',
      status: 'active',
      site_id: null,
      hjy_ignore_confirmed_at: h.clock.now(),
      hjy_ignore_evidence_path: 'fixtures/synthetic-evidence.png',
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
    })
    .execute();
  const body = JSON.stringify(envelope('pdd.ddk.goods.search', [goodsRow()]));
  const fetchDouble = vi.fn(async () => {
    h.clock.advanceMs(29);
    return new Response(body, { status: 200 });
  });
  vi.stubGlobal('fetch', fetchDouble);
  const live = await assemble(h.clock, db);
  const ctx = { appId: h.appId, requestId: 'fake-wiring', purpose: 'online' as const };
  try {
    const result = await outcome(() =>
      live.registry.get('pdd').searchItems({ keyword: '合成商品' }, ctx),
    );
    expect(result).not.toBeInstanceOf(Error);
    expect(fetchDouble).toHaveBeenCalledTimes(1);
    const stored = await rows(reader, h.appId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      app_id: h.appId,
      platform: 'pdd',
      kind: 'query',
      latency_ms: 29,
      error_code: null,
      fetched_at: h.clock.now(),
    });
    expect(gunzipSync(stored[0]!.payload).toString()).toBe(body);
    expect(stored[0]!.request_summary).toMatchObject({ params: { type: 'pdd.ddk.goods.search' } });
    expect(JSON.stringify(stored[0]!.request_summary)).not.toMatch(/client_id|"sign"|fake-pass!/);
    expect(live.logger.warn).not.toHaveBeenCalled();
    expect(live.logger.error).not.toHaveBeenCalled();
    const demo = await assemble(h.clock, db, 'demo');
    try {
      const page = await demo.registry.get('pdd').searchItems({ keyword: '演示' }, ctx);
      expect(page.items.length).toBeGreaterThan(0);
      expect(await rows(reader, h.appId)).toEqual(stored);
      expect(fetchDouble).toHaveBeenCalledTimes(1);
    } finally {
      await demo.context.close();
    }
  } finally {
    await live.context.close();
  }
});

it('[AC-B1-04p-WIRING#2] 可选 DB 缺席仍可调用非商品接口，归档不可用只在启动 warn 一次', async () => {
  const h = harness(db);
  const fetchDouble = vi.fn(async () => new Response('{"authority_query_response":{"bind":1}}'));
  vi.stubGlobal('fetch', fetchDouble);
  const live = await assemble(h.clock);
  try {
    expect(live.logger.warn).toHaveBeenCalledTimes(1);
    const startupLogs = JSON.stringify(live.logger.warn.mock.calls);
    expect(startupLogs).not.toMatch(/fake-pass!|synthetic-unused-file/);
    const adapter = live.registry.get('pdd');
    expect(adapter.queryPddAuthority).toBeTypeOf('function');
    for (let i = 0; i < 2; i++) {
      const result = await outcome(() =>
        adapter.queryPddAuthority!(new TestIdentity(undefined, { appId: h.appId }), {
          appId: h.appId,
          requestId: 'fake-no-db',
          purpose: 'online',
        }),
      );
      expect(result).toEqual({ authorized: true });
    }
    expect(fetchDouble).toHaveBeenCalledTimes(2);
    expect(live.logger.warn).toHaveBeenCalledTimes(1);
    expect(live.logger.error).not.toHaveBeenCalled();
    expect(await rows(reader, h.appId)).toEqual([]);
  } finally {
    await live.context.close();
  }
});
