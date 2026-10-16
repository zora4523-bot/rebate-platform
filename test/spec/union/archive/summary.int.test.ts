import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createArchivingTransport } from '../../../../apps/api/src/modules/union/infra/archive.ts';
import { harness, request, response, rows } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app') });
});
afterAll(async () => {
  if (db) await destroyDb(db);
  if (database) await database.drop();
});

const sensitiveNames = [
  'appKey',
  'APP_KEY',
  'app-key',
  'client_id',
  'CLIENT-ID',
  'clientId',
  'secret',
  'SECRET',
  'client_secret',
  'clientSecret',
  'APP_SECRET',
  'app-secret',
  'sign',
  'SiGn',
  'session',
  'SESSION',
  'session_key',
  'Session-Key',
  'access_token',
  'Access-Token',
  'accessToken',
  'refresh_token',
  'RefreshToken',
  'vendor_SECRET',
  'vendor-Token',
  'vendorToken',
];

it.each(['json', 'form'] as const)(
  '[AC-B1-04p-SUMMARY#1] %s 摘要合并 query/body，删所有敏感键，保留业务参数且不存 headers/raw body',
  async (encoding) => {
    const h = harness(db);
    const business = {
      type: 'synthetic.query',
      p_id: 'fake-pid',
      goods_sign: 'fake-goods-sign',
      custom_parameters: '{"uid":"fake-attr"}',
      order_sn: 'synthetic-order-123456',
    };
    const sensitive = Object.fromEntries(sensitiveNames.map((name, i) => [name, `fake-${i}!`]));
    const parameters = { ...sensitive, ...business };
    const query = new URLSearchParams({ ...sensitive, query_only: '查询值' });
    const body =
      encoding === 'json' ? JSON.stringify(parameters) : new URLSearchParams(parameters).toString();
    const input = request(h.appId, {
      url: `https://synthetic.invalid:8443/router/path?${query.toString()}#fragment`,
      body,
      headers: {
        'Content-Type':
          encoding === 'json'
            ? 'application/json; charset=utf-8'
            : 'application/x-www-form-urlencoded; charset=UTF-8',
        authorization: 'fake-auth!',
        cookie: 'fake-cookie!',
        'x-innocent': 'fake-header!',
      },
    });
    const original = structuredClone(input);
    const wrapped = createArchivingTransport(async () => response(), h);
    await wrapped(input);
    const stored = await rows(db, h.appId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.request_summary).toEqual({
      method: 'POST',
      url: 'https://synthetic.invalid:8443/router/path',
      params: { query_only: '查询值', ...business },
    });
    expect(input).toEqual(original);
    const serialized = JSON.stringify(stored[0]!.request_summary);
    for (const value of [
      ...Object.values(sensitive),
      'fake-auth!',
      'fake-cookie!',
      'fake-header!',
    ]) {
      expect(serialized).not.toContain(value);
    }
  },
);

it.each(['{broken:中文😀', '["fake-array!"]', 'null', '"fake-scalar!"'])(
  '[AC-B1-04p-SUMMARY#2] 非 JSON 对象请求体 %s 只存 UTF-8 字节数，连 query params 也不存',
  async (body) => {
    const h = harness(db);
    const wrapped = createArchivingTransport(async () => response(), h);
    await wrapped(
      request(h.appId, {
        body,
        url: 'https://synthetic.invalid/router?sign=fake-sign!&type=query',
      }),
    );
    const stored = await rows(db, h.appId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.request_summary).toEqual({
      method: 'POST',
      url: 'https://synthetic.invalid/router',
      body_bytes: Buffer.byteLength(body, 'utf8'),
    });
  },
);

it('[AC-B1-04p-SUMMARY#3] 无请求体 GET 从查询串提取业务参数，URL 不含查询串或凭据', async () => {
  const h = harness(db);
  const wrapped = createArchivingTransport(async () => response(), h);
  const input = request(h.appId, {
    method: 'GET',
    headers: {},
    url: 'https://synthetic.invalid/router?SIGN=fake-sign!&goods_sign=keep-me',
  });
  delete (input as { body?: string }).body;
  await wrapped(input);
  const stored = await rows(db, h.appId);
  expect(stored).toHaveLength(1);
  expect(stored[0]!.request_summary).toEqual({
    method: 'GET',
    url: 'https://synthetic.invalid/router',
    params: { goods_sign: 'keep-me' },
  });
});
