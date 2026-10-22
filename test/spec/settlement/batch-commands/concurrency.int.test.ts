import { createTestDatabase } from '@couli/db/testing';
import type { KyselyPlugin, QueryId } from 'kysely';
import { expect, it } from 'vitest';
import { createBatchCommandService } from '../../../../apps/api/src/modules/settlement/batch/commands/service.ts';
import {
  CONFLICT,
  FUTURE,
  command,
  confirm,
  databaseFixture,
  fixture,
  rejectedUnchanged,
  seedBatch,
  seedItem,
  state,
  stored,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

it('[AC-B2-04o#27] 整轮最后一个批次版本过期，返回 20902 settle_batch，前面批次也不能提交', async () => {
  const h = await fixture(database.db);
  const a = await seedBatch(h, { batch_id: '00000000-0000-4000-8000-000000000001' });
  const b = await seedBatch(h, { batch_id: '00000000-0000-4000-8000-000000000002' });
  await seedItem(h, a);
  await h.db
    .updateTable('settle_batches')
    .set({ row_version: b.row_version + 1 })
    .where('app_id', '=', h.appId)
    .where('batch_id', '=', b.batch_id)
    .execute();
  await rejectedUnchanged(h, () => h.service().confirmBill(confirm(h, [a, b])), CONFLICT);
});

it.each(['cancelSchedule', 'rejectBatch', 'resumeBatch'] as const)(
  '[AC-B2-04o#28] %s CAS 读版本过期映射 20902 settle_batch，不覆盖现有值',
  async (method) => {
    const h = await fixture(database.db);
    const status =
      method === 'cancelSchedule' ? 'CONFIRMED' : method === 'rejectBatch' ? 'DRAFT' : 'PARTIAL';
    const b = await seedBatch(h, {
      status,
      settle_mode: 'SCHEDULED',
      scheduled_at: new Date(FUTURE),
    });
    await seedItem(h, b);
    await h.db
      .updateTable('settle_batches')
      .set({ row_version: b.row_version + 1 })
      .where('app_id', '=', h.appId)
      .where('batch_id', '=', b.batch_id)
      .execute();
    await rejectedUnchanged(
      h,
      () => {
        const service = h.service();
        const input = command(h, b);
        return method === 'rejectBatch'
          ? service.rejectBatch({ ...input, reason: '核对' })
          : service[method](input);
      },
      CONFLICT,
    );
  },
);

it('[AC-B2-04o#29] 确认后撤销形成 DRAFT→CONFIRMED→DRAFT，旧草稿版本仍不能重放', async () => {
  const h = await fixture(database.db);
  const b = await seedBatch(h);
  const service = h.service();
  const original = confirm(h, [b], { mode: 'SCHEDULED', scheduledAt: new Date(FUTURE) });
  await service.confirmBill(original);
  await service.cancelSchedule(command(h, await stored(h, b)));
  expect(await stored(h, b)).toMatchObject({ status: 'DRAFT', row_version: b.row_version + 2 });
  await rejectedUnchanged(h, () => service.confirmBill(original), CONFLICT);
});

it('[AC-B2-04o#30] 两次确认竞争同一整轮，只有一次成功，输者冲突且版本只加一', async () => {
  const h = await fixture(database.db);
  const a = await seedBatch(h);
  const b = await seedBatch(h, { platform: 'jd' });
  const first = h.service();
  const second = h.service();
  const results = await Promise.allSettled([
    first.confirmBill(confirm(h, [a, b])),
    second.confirmBill(confirm(h, [b, a])),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const failures = results.filter((r) => r.status === 'rejected');
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ reason: CONFLICT });
  for (const batch of [a, b])
    expect(await stored(h, batch)).toMatchObject({
      status: 'CONFIRMED',
      row_version: batch.row_version + 1,
    });
});

it('[AC-B2-04o#31] SB8 两次继续竞争，不能重复从同一 PARTIAL 版本启动', async () => {
  const h = await fixture(database.db);
  const b = await seedBatch(h, { status: 'PARTIAL' });
  const first = h.service();
  const second = h.service();
  const results = await Promise.allSettled([
    first.resumeBatch(command(h, b)),
    second.resumeBatch(command(h, b)),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toEqual([
    expect.objectContaining({ reason: expect.objectContaining(CONFLICT) }),
  ]);
  expect(await stored(h, b)).toMatchObject({ status: 'EXECUTING', row_version: b.row_version + 1 });
});

it('[AC-B2-04o#32] 本轮增加新草稿后，旧确认页面的版本集合不能漏确认新增批次', async () => {
  const h = await fixture(database.db);
  const b = await seedBatch(h);
  const original = confirm(h, [b]);
  await seedBatch(h, { platform: 'jd' });
  await rejectedUnchanged(h, () => h.service().confirmBill(original), CONFLICT);
});

it('[AC-B2-04o#33] 批次写入返回阶段出错也回滚整轮，不能留下部分已确认', async () => {
  const h = await fixture(database.db);
  const batches = [await seedBatch(h), await seedBatch(h)];
  await seedItem(h, batches[0]!);
  const before = await state(h);
  const updates = new Set<QueryId>();
  const failure = new Error('synthetic batch write failure');
  // 真实 PG 已执行 UPDATE 后注入失败；既兼容逐批 CAS，也兼容单语句批量 CAS。
  // 不伪造读写结果，随后从独立池连接读取数据库核对事务回滚。
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      if (args.node.kind === 'UpdateQueryNode') updates.add(args.queryId);
      return args.node;
    },
    async transformResult(args) {
      if (updates.delete(args.queryId)) throw failure;
      return args.result;
    },
  };
  const service = createBatchCommandService({ ...h.deps, db: h.db.withPlugin(plugin) });
  await expect(service.confirmBill(confirm(h, batches))).rejects.toThrow(failure.message);
  expect(await state(h)).toEqual(before);
});

it('[AC-B2-04o#34] 权威轮次误含另一 app 的成员时整轮拒绝，不能遗漏 app_id 过滤', async () => {
  const h = await fixture(database.db);
  const other = await fixture(database.db);
  const a = await seedBatch(h);
  const b = await seedBatch(other);
  h.roundIds.push(b.batch_id);
  const before = await state(other);
  await rejectedUnchanged(h, () => h.service().confirmBill(confirm(h, [a, b])), CONFLICT);
  expect(await state(other)).toEqual(before);
});

it('[AC-B2-04o#35] 权威轮次误含同 app 另一账单的成员时不能越账单确认', async () => {
  const h = await fixture(database.db);
  const a = await seedBatch(h);
  await h.db
    .insertInto('settle_bills')
    .values({
      app_id: h.appId,
      bill_id: '2032-05',
      generation_started_at: h.clock.now(),
      generated_at: h.clock.now(),
    })
    .execute();
  const b = await seedBatch(h, { bill_id: '2032-05' });
  await rejectedUnchanged(h, () => h.service().confirmBill(confirm(h, [a, b])), CONFLICT);
});
