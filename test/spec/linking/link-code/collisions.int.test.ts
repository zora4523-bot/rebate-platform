import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { built, codeDb, databaseFixture, registration, row, seedLink } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it('[AC-B1-08s#9] 撞一次重抽后成功，登记及 register 日志仍在同一未中止事务', async () => {
  const db = await codeDb(database());
  await seedLink(db, 'aaaaaa', { platform: 'pdd' });
  const f = registration(database());
  f.linkCode.mockReturnValueOnce('aaaaaa').mockReturnValue('bbbbbb');
  const link = await built(f.register);
  expect((await row(db, link.linkId)).lk).toBe('bbbbbb');
  expect(f.linkCode).toHaveBeenCalledTimes(2);
  expect(f.error).not.toHaveBeenCalled();
  const xids = await sql<{ same: boolean }>`SELECT l.xmin = g.xmin AS same
    FROM app.links l JOIN app.link_logs g ON l.app_id = g.app_id AND l.link_id = g.link_id
    WHERE l.link_id = ${link.linkId}::uuid AND g.event = 'register'`.execute(db);
  expect(xids.rows).toEqual([{ same: true }]);
});

it('[AC-B1-08s#10] 首次加三次重试均冲突后登记 NULL 并仅告警一次，外层日志照常提交', async () => {
  const db = await codeDb(database());
  const codes = ['ccccc1', 'ccccc2', 'ccccc3', 'ccccc4'];
  for (const code of codes) await seedLink(db, code);
  const f = registration(database());
  for (const code of codes) f.linkCode.mockReturnValueOnce(code);
  f.linkCode.mockImplementation(() => {
    throw new Error('fifth draw forbidden');
  });
  const link = await built(f.register);
  expect((await row(db, link.linkId)).lk).toBeNull();
  expect(f.linkCode).toHaveBeenCalledTimes(4);
  expect(f.error).toHaveBeenCalledTimes(1);
  expect(f.error.mock.calls[0]![0]).toEqual({
    event: 'linking.link_code.exhausted',
    app_id: 'register-app',
    platform: 'jd',
  });
  const logs = await db
    .selectFrom('link_logs')
    .select(['event', 'result_code'])
    .where('link_id', '=', link.linkId)
    .execute();
  expect(logs).toEqual([{ event: 'register', result_code: 0 }]);
});

it('[AC-B1-08s#11] 第四次抽号仍可成功；其他 App 同码不触发重试', async () => {
  const db = await codeDb(database());
  for (const code of ['dddd01', 'dddd02', 'dddd03']) await seedLink(db, code);
  await seedLink(db, 'dddd04', { app_id: 'collision-other', user_id: null });
  const f = registration(database());
  for (const code of ['dddd01', 'dddd02', 'dddd03', 'dddd04']) f.linkCode.mockReturnValueOnce(code);
  const link = await built(f.register);
  expect((await row(db, link.linkId)).lk).toBe('dddd04');
  expect(f.linkCode).toHaveBeenCalledTimes(4);
  expect(f.error).not.toHaveBeenCalled();
});

it('[AC-B1-08s#12] 并发登记同码由数据库裁决，一个重抽、两个 link 和日志均提交', async () => {
  const db = await codeDb(database());
  const a = registration(database());
  const b = registration(database());
  a.linkCode.mockReturnValueOnce('eeee00').mockReturnValue('eeee01');
  b.linkCode.mockReturnValueOnce('eeee00').mockReturnValue('eeee02');
  const links = await built(() => Promise.all([a.register(), b.register()]));
  const rows = await Promise.all(links.map((link) => row(db, link.linkId)));
  expect(rows.map((link) => link.lk)).toContain('eeee00');
  expect(new Set(rows.map((link) => link.lk)).size).toBe(2);
  expect(a.linkCode.mock.calls.length + b.linkCode.mock.calls.length).toBe(3);
  expect(
    await db
      .selectFrom('link_logs')
      .select('id')
      .where(
        'link_id',
        'in',
        links.map((link) => link.linkId),
      )
      .execute(),
  ).toHaveLength(2);
});
