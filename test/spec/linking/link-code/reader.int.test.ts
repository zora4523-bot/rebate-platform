import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createOrderSourceReader } from '../../../../apps/api/src/modules/linking/index.ts';
import { USER_B } from '../register/kit.ts';
import { built, codeDb, databaseFixture, seedLink, type CodeReader } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it('[AC-B1-08s#15] 反查按 app/platform/lk 隔离，属他人和游客的行原样返回，读口不判归属', async () => {
  const db = await codeDb(database());
  const a = await seedLink(db, 'read01', { user_id: USER_B, scene: 'agent' });
  const b = await seedLink(db, 'read01', { app_id: 'reader-other', user_id: null });
  const reader = (await built(() => createOrderSourceReader(database()))) as unknown as CodeReader;
  expect(typeof reader.linkByCode).toBe('function');
  const read = (appId: string, platform = 'jd', lk = 'read01') =>
    built(() => reader.linkByCode({ appId, platform, lk }));
  expect(await read('register-app')).toEqual({
    link_id: a.link_id,
    user_id: USER_B,
    scene: 'agent',
    agent_session_id: null,
  });
  expect(await read('reader-other')).toEqual({
    link_id: b.link_id,
    user_id: null,
    scene: 'detail',
    agent_session_id: null,
  });
  expect(await read('missing')).toBeNull();
  expect(await read('register-app', 'pdd')).toBeNull();
  expect(await read('register-app', 'jd', 'absent')).toBeNull();
  expect(
    await db.selectFrom('links').selectAll().where('link_id', '=', a.link_id).execute(),
  ).toEqual([a]);
});
