import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { capture, codeDb, databaseFixture, seedLink } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it('[AC-B1-08s#3] lk 可空无默认值；同 App 跨平台唯一、跨 App 可重复、多个 NULL 可共存', async () => {
  const db = await codeDb(database());
  await seedLink(db, 'a1b2c3');
  expect(await capture(() => seedLink(db, 'a1b2c3', { platform: 'pdd' }))).toMatchObject({
    ok: false,
    error: { code: '23505', constraint: 'links_app_id_lk_key' },
  });
  expect(
    await capture(() => seedLink(db, 'a1b2c3', { app_id: 'other-app', user_id: null })),
  ).toMatchObject({ ok: true, value: { lk: 'a1b2c3' } });
  expect((await seedLink(db, null)).lk).toBeNull();
  expect((await seedLink(db, null)).lk).toBeNull();
});

it('[AC-B1-08s#4] CHECK 接受 1～16 位小写 base36，拒绝空串、大写、标点、换行与 17 位', async () => {
  const db = await codeDb(database());
  for (const lk of ['0', 'zzzzzzzzzzzzzzzz']) expect((await seedLink(db, lk)).lk).toBe(lk);
  for (const lk of ['', 'A1b2c3', 'z'.repeat(17), 'abc_def', 'abc\n', '中文']) {
    expect(await capture(() => seedLink(db, lk))).toMatchObject({
      ok: false,
      error: { code: '23514' },
    });
  }
});
