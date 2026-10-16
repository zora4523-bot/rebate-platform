import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createArchivingTransport } from '../../../../apps/api/src/modules/union/infra/archive.ts';
import { harness, request, response, rows } from '../archive/kit.ts';
import { ctx, win } from '../pdd-orders/kit.ts';
import { envelope, pdd, reply, sourceRow, sources, value } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
let reader: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  reader = createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 });
});
afterAll(async () => {
  if (reader) await destroyDb(reader);
  if (db) await destroyDb(db);
  if (database) await database.drop();
});

it('[AC-B1-08e-ARCHIVE-DB#1] 回传已提交行的十进制 ID，同一报文两次请求各有自己的行', async () => {
  const h = harness(db);
  const wrapped = createArchivingTransport(async () => response('synthetic raw response'), h);
  const first = await wrapped(request(h.appId));
  const afterFirst = await rows(reader, h.appId);
  expect(afterFirst).toHaveLength(1);
  expect(value(first, 'raw_payload_id')).toBe(afterFirst[0]!.id.toString());
  const second = await wrapped(request(h.appId));
  const stored = await rows(reader, h.appId);
  expect(stored).toHaveLength(2);
  expect(value(second, 'raw_payload_id')).toBe(stored[1]!.id.toString());
  expect(value(first, 'raw_payload_id')).not.toBe(value(second, 'raw_payload_id'));
  expect(stored[0]!.content_hash).toBe(stored[1]!.content_hash);
  expect(first.status).toBe(200);
  expect(first.body).toBe('synthetic raw response');
  expect(h.logger.error).not.toHaveBeenCalled();
});

it.each(sources)(
  '[AC-B1-08e-ARCHIVE-DB#2] %s 适配器订单的 raw_payload_id 可定位本 app 的本页原文',
  async (source) => {
    const h = harness(db);
    const wire = reply(envelope(source, sourceRow(source)));
    const transport = createArchivingTransport(async () => wire, h);
    const adapter = pdd(transport);
    const context = { ...ctx, appId: h.appId };
    const order =
      source === 'detail'
        ? await adapter.getPddOrderDetail('synthetic-detail', context)
        : (await adapter.listOrders(win, { queryMode: source }, context)).items[0]!;
    const stored = await rows(reader, h.appId);
    expect(stored).toHaveLength(1);
    expect(value(order, 'raw_payload_id')).toBe(stored[0]!.id.toString());
    expect(stored[0]).toMatchObject({ app_id: h.appId, platform: 'pdd', kind: 'order' });
    expect(gunzipSync(stored[0]!.payload).toString('utf8')).toBe(wire.body);
    expect(h.logger.error).not.toHaveBeenCalled();
  },
);
