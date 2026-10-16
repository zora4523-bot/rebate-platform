import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createArchivingTransport } from '../../../../apps/api/src/modules/union/infra/archive.ts';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/infra/demo/demo-adapter.ts';
import { createUnionFileReplay } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { recording, request as replayRequest, workspace, writeRecording } from '../replay/kit.ts';
import { harness, rows } from './kit.ts';

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

it('[AC-B1-04p-MODE#1] 文件回放经包装每次归档；同 app 的演示适配器操作不增加归档', async () => {
  const h = harness(db);
  await workspace(async (directory) => {
    await writeRecording(directory, 'pdd');
    const replay = createUnionFileReplay({ directory, clock: h.clock });
    const wrapped = createArchivingTransport(replay.transport, h);
    const input = { ...replayRequest('pdd'), archive: { appId: h.appId, kind: 'query' } };
    expect(await wrapped(input)).toEqual(recording().response);
    expect(await wrapped(input)).toEqual(recording().response);
    const archived = await rows(db, h.appId);
    expect(archived).toHaveLength(2);
    expect(archived.map((entry) => gunzipSync(entry.payload).toString())).toEqual([
      recording().response.body,
      recording().response.body,
    ]);
    for (const entry of archived)
      expect(entry).toMatchObject({
        app_id: h.appId,
        platform: 'pdd',
        kind: 'query',
        error_code: null,
      });
    const demo = new DemoUnionAdapter({
      platform: 'pdd',
      clock: h.clock,
      seed: 'fake-demo',
      environment: 'test',
    });
    const ctx = { appId: h.appId, requestId: 'fake-demo', purpose: 'online' as const };
    const page = await demo.searchItems({ keyword: '演示' }, ctx);
    expect(page.items.length).toBeGreaterThan(0);
    await demo.getItem(page.items[0]!, ctx);
    await demo.materialFeed({}, ctx);
    expect(await rows(db, h.appId)).toEqual(archived);
  });
});
