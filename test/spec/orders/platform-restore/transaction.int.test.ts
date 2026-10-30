// B1-08zc：登记与本次同步更新同一事务（编排 9.2 第 1、2、5 条）：判定在 CAS 写成功之后；端口抛错整次更新回滚
// （platform_status 不变，下一次投递再登记）；端口回报「未插入」（同键已由别处登记）不告警；未注入端口时不登记、
// 现有行为不变（P9 告警照旧）。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  expectNoRestore,
  expectNotRevived,
  expectP9Warn,
  scenario,
  type RestoreSpec,
} from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

const REFUND_VOID: RestoreSpec = {
  rebate: 'VOID',
  reason: 'REFUND',
  entry: { from: 'ESTIMATED', event: 'PLATFORM_INVALID', to: 'VOID' },
  imported: 'invalid',
};
const UPDATED = { ok: true, value: { kind: 'updated' } } as const;

it('[AC-B1-08zc#19] 端口在本次 CAS 写入之后、同一事务内调用：事务里已看得到新的 platform_status 与 row_version', async () => {
  const f = await scenario(db, REFUND_VOID);
  const seen: { platform_status: string; row_version: number }[] = [];
  f.register.mockImplementationOnce(async (trx, input) => {
    seen.push(
      await trx
        .selectFrom('orders')
        .select(['platform_status', 'row_version'])
        .where('app_id', '=', f.ctx.app_id)
        .executeTakeFirstOrThrow(),
    );
    return f.realRegister(trx, input);
  });
  expect(await f.sync({ raw_status: 'paid' })).toMatchObject(UPDATED);
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(seen).toEqual([{ platform_status: 'PAID', row_version: f.original.row_version + 1 }]);
  expect(f.register.mock.calls[0]?.[0]).toBe(f.onUpdated.mock.calls[0]?.[0]);
  expect(await f.diffs()).toHaveLength(1);
});

it('[AC-B1-08zc#20] 端口抛错 → 整次更新回滚（platform_status、history 不变，无差错单、无告警）；下一次投递照常登记', async () => {
  const f = await scenario(db, REFUND_VOID);
  const prior = { order: await f.order(), history: await f.history() };
  const boom = new Error('synthetic recon diff failure');
  f.register.mockRejectedValueOnce(boom);
  expect(await f.sync({ raw_status: 'paid' })).toEqual({ ok: false, error: boom });
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(await f.order()).toEqual(prior.order);
  expect((await f.order()).platform_status).toBe('INVALID');
  expect(await f.history()).toEqual(prior.history);
  expect(await f.diffs()).toEqual([]);
  expect(f.restoreWarns()).toEqual([]);

  // 至少一次投递：同一报文再来一次，这次端口正常 → 登记一张。
  expect(await f.sync()).toMatchObject(UPDATED);
  expect((await f.order()).platform_status).toBe('PAID');
  expect(await f.diffs()).toHaveLength(1);
  expect(f.restoreWarns()).toHaveLength(1);
});

it('[AC-B1-08zc#21] 端口回报未插入（同键已由别处登记）→ 不打 platform_restore 告警，更新照常提交', async () => {
  const f = await scenario(db, REFUND_VOID);
  f.register.mockResolvedValueOnce({ inserted: false, id: '019a0000-0000-7000-8000-000000000001' });
  expect(await f.sync({ raw_status: 'paid' })).toMatchObject(UPDATED);
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.restoreWarns()).toEqual([]);
  expect((await f.order()).platform_status).toBe('PAID');
  expectP9Warn(f);
});

it('[AC-B1-08zc#22] 未注入端口：不登记、无 platform_restore 告警，P9 照常迁移并告警，settlement 端口照常调用；注入后同一情形登记一张', async () => {
  const f = await scenario(db, REFUND_VOID, { port: false });
  expect(await f.sync({ raw_status: 'paid' })).toMatchObject(UPDATED);
  expect((await f.order()).platform_status).toBe('PAID');
  await expectNotRevived(f, 'VOID', 'REFUND');
  await expectNoRestore(f);
  expectP9Warn(f);
  expect(f.onUpdated).toHaveBeenCalledTimes(1);
  expect(f.onUpdated.mock.calls[0]?.[1]).toMatchObject({
    from_status: 'INVALID',
    to_status: 'PAID',
    rule: 'P9',
  });

  const wired = await scenario(db, REFUND_VOID);
  expect(await wired.sync({ raw_status: 'paid' })).toMatchObject(UPDATED);
  expect(await wired.diffs()).toHaveLength(1);
  expect(wired.restoreWarns()).toHaveLength(1);
});
