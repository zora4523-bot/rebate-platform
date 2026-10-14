import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture, failure, fixture, service, success } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it('[AC-B1-06i#13] 相同键重放保留 link_id、attempt_id 和原响应，不再登记、记日志或转链', async () => {
  const f = await fixture(database());
  const input = f.request({ item_ref: f.issue() });
  const convert = service(f);
  const first = await convert.convert(input);
  await success(first, f);
  const before = { links: await f.links(), logs: await f.logs(), attempts: await f.attempts() };
  // A new service instance prevents an in-memory reply map from satisfying persistence.
  const replay = await service(f).convert({ ...input, traceId: f.request().traceId });
  expect(replay).toEqual(first);
  expect({ links: await f.links(), logs: await f.logs(), attempts: await f.attempts() }).toEqual(
    before,
  );
  expect(f.convert).toHaveBeenCalledTimes(1);
}, 60_000);

it.each([
  { product_key: 'jd:i_other' },
  { spm: 'synthetic.second.entry' },
  { installed: 'false' as const },
  { item_ref: 'synthetic-different-item-ref' },
])(
  '[AC-B1-06i#14] 相同幂等键但请求体改变 %j → 20901，无新增副作用',
  async (patch) => {
    const f = await fixture(database());
    const input = f.request();
    const convert = service(f);
    await success(await convert.convert(input), f);
    const before = { links: await f.links(), logs: await f.logs(), attempts: await f.attempts() };
    const result = await service(f).convert({ ...input, body: { ...input.body, ...patch } });
    expect(result).toMatchObject({ status: 409, envelope: { code: 20901 } });
    expect({ links: await f.links(), logs: await f.logs(), attempts: await f.attempts() }).toEqual(
      before,
    );
    expect(f.convert).toHaveBeenCalledTimes(1);
  },
  60_000,
);

it('[AC-B1-06i#15] 授权失败的旧键仍重放原状态；授权后新键才成功', async () => {
  const f = await fixture(database(), 'taobao', 'absent');
  const input = f.request();
  const convert = service(f);
  const first = await convert.convert(input);
  await failure(first, f, 30101, 422);
  const before = { links: await f.links(), logs: await f.logs(), sessions: await f.sessions() };
  // Simulate authorization completing through the fixture writer, without touching the old request.
  await f.db
    .updateTable('union_bindings')
    .set({ status: 'active', relation_id: 'rel-A' })
    .where('app_id', '=', f.appId)
    .where('user_id', '=', f.a)
    .execute();
  if (
    (await f.db.selectFrom('union_bindings').select('id').where('app_id', '=', f.appId).execute())
      .length === 0
  ) {
    await f.bind('active');
  }
  expect(await service(f).convert(input)).toEqual(first);
  expect({ links: await f.links(), logs: await f.logs(), sessions: await f.sessions() }).toEqual(
    before,
  );
  expect(await f.attempts()).toEqual([]);
  const next = await service(f).convert(f.request());
  expect(next).toMatchObject({ status: 200, envelope: { code: 0 } });
  expect(await f.links()).toHaveLength(before.links.length + 1);
  expect(await f.logs()).toHaveLength(2);
  expect(await f.attempts()).toHaveLength(1);
}, 60_000);
