import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  CONFLICT,
  FUTURE,
  NOW,
  confirm,
  databaseFixture,
  fixture,
  rejectedUnchanged,
  seedBatch,
  seedItem,
  stored,
  untouched,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

// BR-FUND-04 ⑥、⑧ / SB2；接口仅是服务层，不承接 B2-09 step-up 或 B2-04p 执行。
it('[AC-B2-04o#1] 默认立即确认本轮全部 DRAFT，跨平台逐批记同一人和 Clock 时刻，不执行明细', async () => {
  const h = await fixture(database.db);
  const a = await seedBatch(h);
  const b = await seedBatch(h, { platform: 'jd', row_version: 9 });
  await seedItem(h, a);
  const before = await untouched(h);
  await h.service().confirmBill(confirm(h, [b, a]));
  for (const batch of [a, b]) {
    expect(await stored(h, batch)).toEqual({
      ...batch,
      status: 'CONFIRMED',
      confirmed_by: h.adminId,
      confirmed_at: new Date(NOW),
      settle_mode: 'IMMEDIATE',
      scheduled_at: null,
      row_version: batch.row_version + 1,
    });
  }
  expect(await untouched(h)).toEqual(before);
  expect(h.currentRound).toHaveBeenCalledWith(expect.objectContaining({ isTransaction: true }), {
    appId: h.appId,
    billId: h.billId,
  });
});

it('[AC-B2-04o#2] 定时确认整轮，所有批次同一 scheduled_at，执行时刻未到不写订单', async () => {
  const h = await fixture(database.db);
  const batches = [await seedBatch(h), await seedBatch(h, { platform: 'pdd' })];
  await seedItem(h, batches[0]!);
  const before = await untouched(h);
  await h
    .service()
    .confirmBill(confirm(h, batches, { mode: 'SCHEDULED', scheduledAt: new Date(FUTURE) }));
  for (const batch of batches) {
    expect(await stored(h, batch)).toEqual({
      ...batch,
      status: 'CONFIRMED',
      confirmed_by: h.adminId,
      confirmed_at: new Date(NOW),
      settle_mode: 'SCHEDULED',
      scheduled_at: new Date(FUTURE),
      row_version: batch.row_version + 1,
    });
  }
  expect(await untouched(h)).toEqual(before);
});

it('[AC-B2-04o#3] 只确认权威本轮中的草稿，旧轮草稿和本轮非草稿均保持原样', async () => {
  const h = await fixture(database.db);
  const oldDraft = await seedBatch(h, {}, false);
  const oldPartial = await seedBatch(h, { status: 'PARTIAL' }, false);
  const current = await seedBatch(h, { kind: 'supplement' });
  const confirmed = await seedBatch(h, { kind: 'supplement', status: 'CONFIRMED' });
  const cancelled = await seedBatch(h, { kind: 'supplement', status: 'CANCELLED' });
  await h.service().confirmBill(confirm(h, [current], { mode: 'IMMEDIATE' }));
  expect(await stored(h, current)).toMatchObject({ status: 'CONFIRMED', row_version: 5 });
  for (const batch of [oldDraft, oldPartial, confirmed, cancelled])
    expect(await stored(h, batch)).toEqual(batch);
});

it('[AC-B2-04o#4] 后续补充轮必须单独确认，不重写已确认首轮的确认信息', async () => {
  const h = await fixture(database.db);
  const main = await seedBatch(h);
  const service = h.service();
  await service.confirmBill(confirm(h, [main]));
  const mainConfirmed = await stored(h, main);
  h.roundIds.length = 0;
  const supplement = await seedBatch(h, { kind: 'supplement' });
  expect(await stored(h, supplement)).toMatchObject({ status: 'DRAFT', confirmed_at: null });
  h.clock.advanceMs(1000);
  await service.confirmBill(confirm(h, [supplement]));
  expect(await stored(h, main)).toEqual(mainConfirmed);
  expect(await stored(h, supplement)).toMatchObject({
    status: 'CONFIRMED',
    confirmed_at: h.clock.now(),
    confirmed_by: h.adminId,
    row_version: 5,
  });
});

it.each([
  ['过去', '2032-07-24T09:59:59.999+08:00'],
  ['等于确认时刻', NOW],
  ['次日零点', '2032-07-25T00:00:00+08:00'],
  ['名义快照中段', '2032-07-25T00:15:00+08:00'],
  ['名义快照结束前一毫秒', '2032-07-25T00:29:59.999+08:00'],
  ['UTC 表示的北京时间零点', '2032-07-24T16:00:00Z'],
  ['无效日期', 'invalid'],
])('[AC-B2-04o#5] 定时拒绝%s，整轮没有部分确认', async (_label, at) => {
  const h = await fixture(database.db);
  const batches = [await seedBatch(h), await seedBatch(h)];
  await rejectedUnchanged(
    h,
    () =>
      h.service().confirmBill(
        confirm(h, batches, {
          mode: 'SCHEDULED',
          scheduledAt: new Date(at),
        }),
      ),
    { name: 'BatchCommandRejected', reason: 'invalid_schedule' },
  );
});

it.each([
  '2032-07-24T10:00:00.001+08:00',
  '2032-07-24T23:59:59.999+08:00',
  '2032-07-25T00:30:00+08:00',
  '2032-07-25T00:00:00Z', // 北京时间 08:00，不能误按 UTC 名义窗口拒绝。
])('[AC-B2-04o#6] 接受名义窗口外的未来时刻 %s，不用执行时快照状态限制保存', async (at) => {
  const h = await fixture(database.db);
  h.readiness.mockResolvedValue({
    autoEnabled: false,
    creditEnabled: false,
    snapshotCompleted: false,
    snapshotTimedOut: false,
  });
  const b = await seedBatch(h);
  await h.service().confirmBill(confirm(h, [b], { mode: 'SCHEDULED', scheduledAt: new Date(at) }));
  expect(await stored(h, b)).toMatchObject({
    status: 'CONFIRMED',
    scheduled_at: new Date(at),
    row_version: 5,
  });
});

it.each([
  { mode: 'SCHEDULED' as const },
  { mode: 'IMMEDIATE' as const, scheduledAt: new Date(FUTURE) },
])('[AC-B2-04o#7] 定时必须提供时间，立即模式不能夹带定时时间：%j', async (extra) => {
  const h = await fixture(database.db);
  const b = await seedBatch(h);
  await rejectedUnchanged(h, () => h.service().confirmBill(confirm(h, [b], extra)), {
    name: 'BatchCommandRejected',
    reason: 'invalid_schedule',
  });
});

it('[AC-B2-04o#8] 每次确认使用当前注入时钟，构造服务时的旧时间不能使过期定时有效', async () => {
  const h = await fixture(database.db);
  const b = await seedBatch(h);
  const service = h.service();
  h.clock.set(FUTURE);
  await rejectedUnchanged(
    h,
    () =>
      service.confirmBill(
        confirm(h, [b], {
          mode: 'SCHEDULED',
          scheduledAt: new Date(FUTURE),
        }),
      ),
    { name: 'BatchCommandRejected', reason: 'invalid_schedule' },
  );
});

it.each(['遗漏一个草稿', '空选择', '重复选择', '夹带旧轮草稿'])(
  '[AC-B2-04o#9] 确认不能变成逐批选择：%s',
  async (scenario) => {
    const h = await fixture(database.db);
    const a = await seedBatch(h);
    const b = await seedBatch(h);
    const old = await seedBatch(h, {}, false);
    const selected =
      scenario === '遗漏一个草稿'
        ? [a]
        : scenario === '空选择'
          ? []
          : scenario === '重复选择'
            ? [a, a, b]
            : [a, b, old];
    await rejectedUnchanged(h, () => h.service().confirmBill(confirm(h, selected)), CONFLICT);
  },
);

it('[AC-B2-04o#10] 本轮无法解析时保守拒绝，不能回退为确认账单所有 DRAFT', async () => {
  const h = await fixture(database.db);
  const b = await seedBatch(h);
  h.currentRound.mockResolvedValue(null);
  await rejectedUnchanged(h, () => h.service().confirmBill(confirm(h, [b])), {
    name: 'BatchCommandRejected',
    reason: 'round_unavailable',
  });
});

it('[AC-B2-04o#11] 账单生成尚未完成时拒绝确认，防止生成途中只确认部分批次', async () => {
  const h = await fixture(database.db);
  const b = await seedBatch(h);
  await h.db
    .updateTable('settle_bills')
    .set({ generated_at: null })
    .where('app_id', '=', h.appId)
    .where('bill_id', '=', h.billId)
    .execute();
  await rejectedUnchanged(h, () => h.service().confirmBill(confirm(h, [b])), {
    name: 'BatchCommandRejected',
    reason: 'bill_not_ready',
  });
});

it('[AC-B2-04o#12] 同账单月的另一个 app 不被确认，确认者及本轮查询绑定当前 app', async () => {
  const h = await fixture(database.db);
  const other = await fixture(database.db);
  const a = await seedBatch(h);
  const b = await seedBatch(other);
  await h.service().confirmBill(confirm(h, [a]));
  expect(await stored(h, a)).toMatchObject({
    app_id: h.appId,
    confirmed_by: h.adminId,
    status: 'CONFIRMED',
  });
  expect(await stored(other, b)).toEqual(b);
  expect(h.currentRound).toHaveBeenCalledWith(expect.anything(), {
    appId: h.appId,
    billId: h.billId,
  });
});
