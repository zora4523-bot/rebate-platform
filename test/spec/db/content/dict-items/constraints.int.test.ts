import { randomUUID } from 'node:crypto';

import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { SHAPE, appId, fixture, insert, rejects, type Connection, type Row } from './kit.ts';

let database: TestDatabase;
let app: Connection;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});
afterAll(async () => {
  if (app) await destroyDb(app);
  await database?.drop();
});

it('[AC-F1-02q#6] version rejects zero and negatives and accepts positive int32 boundaries', async () => {
  const row = await fixture(app);
  for (const version of [0, -1]) {
    await rejects(insert(app, { ...row, version }), 'dict_items_version_check');
  }
  for (const version of [1, 2, 2147483647]) {
    expect(await insert(app, { ...row, version })).toMatchObject({ version });
  }
});

it('[AC-F1-02q#7] uniqueness includes app_id, dict, code and version independently', async () => {
  const row = await fixture(app);
  await insert(app, row);
  await rejects(insert(app, { ...row, text: 'Replacement' }), 'dict_items_pkey', '23505');
  for (const changes of [{ version: 2 }, { app_id: appId() }, { dict: 'error' }, { code: '' }]) {
    expect(await insert(app, { ...row, ...changes })).toMatchObject(changes);
  }
});

it('[AC-F1-02q#8] dict uses lowercase snake keys while code permits empty and dotted keys', async () => {
  const row = await fixture(app);
  for (const dict of [
    '',
    'Order_status',
    'order.status',
    '1abc',
    '_abc',
    'order-status',
    'order ',
    'order\n',
  ]) {
    await rejects(insert(app, { ...row, dict }), 'dict_items_dict_check');
  }
  for (const dict of ['order_status', 'error', 'a', 'a0_']) {
    for (const code of ['', 'SETTLED.label']) {
      expect(await insert(app, { ...row, dict, code })).toMatchObject({ dict, code });
    }
  }
});

it('[AC-F1-02q#9] created_by requires an existing administrator', async () => {
  const row = await fixture(app);
  await rejects(
    insert(app, { ...row, created_by: randomUUID() }),
    'dict_items_created_by_fkey',
    '23503',
  );
  expect(await insert(app, row)).toEqual(row);
});

it('[AC-F1-02q#10] all required columns reject NULL; text supports explicit and omitted fallback', async () => {
  const row = await fixture(app);
  for (const column of Object.keys(SHAPE).filter((name) => name !== 'text')) {
    await expect(insert(app, { ...row, [column]: null })).rejects.toMatchObject({
      code: '23502',
      column,
    });
  }
  expect(await insert(app, { ...row, text: null })).toEqual({ ...row, text: null });
  const omitted: Row = { ...row, version: 2 };
  delete omitted.text;
  expect(await insert(app, omitted)).toEqual({ ...omitted, text: null });
  expect(await insert(app, { ...row, version: 3, text: '' })).toMatchObject({ text: '' });
});
