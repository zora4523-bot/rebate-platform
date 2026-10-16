import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { createArchivingTransport } from '../../../../apps/api/src/modules/union/infra/archive.ts';
import {
  UnionReplayError,
  type UnionTransport,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { harness, outcome, request, response, rows, START } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
let reader: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  reader = createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 });
});
afterAll(async () => {
  if (reader) await destroyDb(reader);
  if (db) await destroyDb(db);
  if (database) await database.drop();
});

it.each(['pdd', 'jd', 'taobao'] as const)(
  '[AC-B1-04p-ROW#1] %s 成功返回前提交一行；原文 gzip/hash、开始结束 Clock、各列正确',
  async (platform) => {
    const h = harness(db);
    const reply = response(
      '  {"session":"fake-sess","order_sn":"synthetic-order-123456","buyer":"合成昵称"}\n',
    );
    const inner = vi.fn<UnionTransport>(async () => {
      h.clock.advanceMs(137);
      return reply;
    });
    const wrapped = createArchivingTransport(inner, h);
    const signal = new AbortController().signal;
    const input = request(h.appId, { platform, signal });
    expect(await wrapped(input)).toBe(reply);
    expect(inner).toHaveBeenCalledExactlyOnceWith(input);
    expect(input).toEqual(request(h.appId, { platform, signal }));
    // A second connection observes committed data immediately after return.
    const stored = await rows(reader, h.appId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      app_id: h.appId,
      platform,
      kind: 'query',
      latency_ms: 137,
      error_code: null,
      fetched_at: new Date(Date.parse(START) + 137),
      request_summary: {
        method: 'POST',
        url: 'https://synthetic.invalid/router',
        params: { type: 'synthetic.query' },
      },
    });
    expect(stored[0]!.id).toBeGreaterThan(0n);
    const payload = stored[0]!.payload;
    expect(payload).toEqual(gzipSync(reply.body));
    expect(gunzipSync(payload).toString('utf8')).toBe(reply.body);
    expect(stored[0]!.content_hash).toBe(createHash('sha256').update(payload).digest('hex'));
    expect(h.logger.error).not.toHaveBeenCalled();
  },
);

it.each([
  [503, '{"error_response":{"error_code":9}}', 'http_503'],
  [302, 'redirect', 'http_302'],
  [200, '{"error_response":{"error_code":50001,"code":8}}', '50001'],
  [200, '{"error_response":{"code":"E-synthetic"}}', 'E-synthetic'],
  [200, '{"error_response":{"error_code":null,"code":0}}', '0'],
  [200, '{"error_response":{"error_code":0,"code":8}}', '0'],
  [200, '{"error_response":{}}', 'undefined'],
  [299, 'not-json', null],
  [204, '', null],
  [200, '[{"error_response":{"code":9}}]', null],
  [200, '{"error_response":null}', null],
] as const)(
  '[AC-B1-04p-ERROR#1] status=%s body=%s 按信封/HTTP 优先级记录错误码 %s',
  async (status, body, code) => {
    const h = harness(db);
    const reply = { ...response(body), status };
    const wrapped = createArchivingTransport(async () => {
      h.clock.advanceMs(19);
      return reply;
    }, h);
    expect(await wrapped(request(h.appId))).toBe(reply);
    const stored = await rows(reader, h.appId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      error_code: code,
      latency_ms: 19,
      fetched_at: new Date(Date.parse(START) + 19),
    });
    expect(gunzipSync(stored[0]!.payload).toString()).toBe(body);
  },
);

it('[AC-B1-04p-ERROR#2] inner 抛 UnionError：提交空 gzip 与原错误码后原样抛出', async () => {
  const h = harness(db);
  const failure = new UnionError('upstream_unavailable', 'fake-upstream-failure', 'pdd');
  const wrapped = createArchivingTransport(async () => {
    h.clock.advanceMs(43);
    throw failure;
  }, h);
  expect(await outcome(() => wrapped(request(h.appId)))).toBe(failure);
  const stored = await rows(reader, h.appId);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    error_code: failure.code,
    latency_ms: 43,
    fetched_at: new Date(Date.parse(START) + 43),
  });
  expect(stored[0]!.payload).toEqual(gzipSync(''));
  expect(stored[0]!.content_hash).toBe(
    createHash('sha256').update(stored[0]!.payload).digest('hex'),
  );
});

it('[AC-B1-04p-TX#1] 调用方事务回滚不回滚报文；相同响应的每次调用各有一行', async () => {
  const h = harness(db);
  const wrapped = createArchivingTransport(async () => response(), h);
  const failure = new Error('synthetic-child-order-failed');
  const result = await outcome(() =>
    db.transaction().execute(async (trx) => {
      await sql`select 1`.execute(trx);
      await wrapped(request(h.appId));
      expect(await rows(reader, h.appId)).toHaveLength(1);
      throw failure;
    }),
  );
  expect(result).toBe(failure);
  await wrapped(request(h.appId));
  const stored = await rows(reader, h.appId);
  expect(stored).toHaveLength(2);
  expect(stored[0]!.content_hash).toBe(stored[1]!.content_hash);
  expect(stored[0]!.id).not.toBe(stored[1]!.id);
});

it.each([
  ['普通 Error', new Error('fake-network-failure!')],
  ['带 code 的非 UnionError', new UnionReplayError('recording_mismatch', 'fake-replay-failure!')],
] as const)(
  '[AC-B1-04p-ERROR#3] %s 先归档空响应且 error_code 为 NULL，再原样抛出',
  async (_label, failure) => {
    const h = harness(db);
    const wrapped = createArchivingTransport(async () => {
      throw failure;
    }, h);
    expect(await outcome(() => wrapped(request(h.appId)))).toBe(failure);
    const stored = await rows(reader, h.appId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      app_id: h.appId,
      platform: 'pdd',
      kind: 'query',
      latency_ms: 0,
      error_code: null,
      fetched_at: new Date(START),
    });
    expect(stored[0]!.payload).toEqual(gzipSync(''));
  },
);

it('[AC-B1-04p-ROW#2] 并发 app/platform/kind 与响应不会串行归属，先完成请求先入库', async () => {
  const h = harness(db);
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const wrapped = createArchivingTransport(async (input) => {
    if (++calls === 2) started.resolve();
    await (input.platform === 'pdd' ? first.promise : second.promise);
    return response(input.platform);
  }, h);
  const a = wrapped(request(h.appId, { archive: { appId: h.appId, kind: 'order' } }));
  const otherApp = `${h.appId}-other`;
  const b = wrapped(
    request(otherApp, { platform: 'taobao', archive: { appId: otherApp, kind: 'rights' } }),
  );
  try {
    await started.promise;
    h.clock.advanceMs(13);
    second.resolve();
    expect(await b).toEqual(response('taobao'));
    expect(await rows(reader, h.appId)).toEqual([]);
    h.clock.advanceMs(17);
    first.resolve();
    expect(await a).toEqual(response('pdd'));
    const [storedA, storedB] = await Promise.all([rows(reader, h.appId), rows(reader, otherApp)]);
    expect(storedA).toHaveLength(1);
    expect(storedB).toHaveLength(1);
    expect(storedA[0]).toMatchObject({
      app_id: h.appId,
      platform: 'pdd',
      kind: 'order',
      latency_ms: 30,
    });
    expect(storedB[0]).toMatchObject({
      app_id: otherApp,
      platform: 'taobao',
      kind: 'rights',
      latency_ms: 13,
    });
    expect(gunzipSync(storedA[0]!.payload).toString()).toBe('pdd');
    expect(gunzipSync(storedB[0]!.payload).toString()).toBe('taobao');
  } finally {
    first.resolve();
    second.resolve();
    await Promise.allSettled([a, b]);
  }
});
