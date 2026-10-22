import { expect, it } from 'vitest';
import {
  FUTURE,
  NOW,
  PAST,
  STATES,
  command,
  confirm,
  databaseFixture,
  fixture,
  rejectedUnchanged,
  seedBatch,
  seedItem,
  state,
  stored,
  untouched,
} from './kit.ts';

const database = databaseFixture();

it.each([null, new Date(PAST)])(
  '[AC-B2-04o#13] SB3 未开始的定时批次可撤销，包括因开关停住的批次 %s',
  async (paused) => {
    const h = await fixture(database.db);
    const b = await seedBatch(h, {
      status: 'CONFIRMED',
      settle_mode: 'SCHEDULED',
      scheduled_at: new Date(PAST),
      paused_by_switch_at: paused,
    });
    await seedItem(h, b);
    const before = await untouched(h);
    await h.service().cancelSchedule(command(h, b));
    expect(await stored(h, b)).toMatchObject({ status: 'DRAFT', row_version: b.row_version + 1 });
    expect(await untouched(h)).toEqual(before);
  },
);

it('[AC-B2-04o#14] 撤销后必须重新确认，可改为立即结算并写新的确认时间', async () => {
  const h = await fixture(database.db);
  const b = await seedBatch(h, {
    status: 'CONFIRMED',
    settle_mode: 'SCHEDULED',
    scheduled_at: new Date(FUTURE),
  });
  const service = h.service();
  await service.cancelSchedule(command(h, b));
  h.clock.advanceMs(1000);
  const draft = await stored(h, b);
  await service.confirmBill(confirm(h, [draft]));
  expect(await stored(h, b)).toMatchObject({
    status: 'CONFIRMED',
    settle_mode: 'IMMEDIATE',
    scheduled_at: null,
    confirmed_by: h.adminId,
    confirmed_at: h.clock.now(),
    row_version: b.row_version + 2,
  });
});

it.each([
  ...STATES.filter((s) => s !== 'CONFIRMED').map((status) => ({
    status,
    settle_mode: 'SCHEDULED',
    scheduled_at: new Date(FUTURE),
  })),
  { status: 'CONFIRMED', settle_mode: 'IMMEDIATE', scheduled_at: null },
  {
    status: 'CONFIRMED',
    settle_mode: 'SCHEDULED',
    scheduled_at: new Date(FUTURE),
    started_at: new Date(PAST),
  },
])('[AC-B2-04o#15] SB3 拒绝不满足源状态、定时或尚未执行条件的批次 %j', async (values) => {
  const h = await fixture(database.db);
  const b = await seedBatch(h, values);
  await rejectedUnchanged(h, () => h.service().cancelSchedule(command(h, b)), {
    name: 'IllegalTransition',
  });
});

it('[AC-B2-04o#16] SB4 草稿驳回持久化原因，订单仍 WAITING，明细和账务不变', async () => {
  const h = await fixture(database.db);
  const b = await seedBatch(h);
  await seedItem(h, b);
  const before = await untouched(h);
  await h.service().rejectBatch({ ...command(h, b), reason: '联盟账单需要核对' });
  expect(await stored(h, b)).toEqual({
    ...b,
    status: 'CANCELLED',
    cancelled_reason: '联盟账单需要核对',
    row_version: 5,
  });
  expect(await untouched(h)).toEqual(before);
});

it.each(['', ' ', '\t\n'])('[AC-B2-04o#17] SB4 拒绝空白原因 %j 且不改批次', async (reason) => {
  const h = await fixture(database.db);
  const b = await seedBatch(h);
  await rejectedUnchanged(h, () => h.service().rejectBatch({ ...command(h, b), reason }), {
    name: 'BatchCommandRejected',
    reason: 'reason_required',
  });
});

it.each(STATES.filter((s) => s !== 'DRAFT'))(
  '[AC-B2-04o#18] SB4 %s 不可驳回取消',
  async (status) => {
    const h = await fixture(database.db);
    const b = await seedBatch(h, { status });
    await rejectedUnchanged(
      h,
      () => h.service().rejectBatch({ ...command(h, b), reason: '不能取消已确认批次' }),
      { name: 'IllegalTransition' },
    );
  },
);

it('[AC-B2-04o#19] 已确认的定时批次不能直接驳回，须先 SB3 回到草稿', async () => {
  const h = await fixture(database.db);
  const b = await seedBatch(h, {
    status: 'CONFIRMED',
    settle_mode: 'SCHEDULED',
    scheduled_at: new Date(FUTURE),
  });
  await rejectedUnchanged(h, () => h.service().rejectBatch({ ...command(h, b), reason: '核对' }), {
    name: 'IllegalTransition',
  });
  const service = h.service();
  await service.cancelSchedule(command(h, b));
  await service.rejectBatch({ ...command(h, await stored(h, b)), reason: '核对' });
  expect(await stored(h, b)).toMatchObject({
    status: 'CANCELLED',
    cancelled_reason: '核对',
    row_version: 6,
  });
});

it.each([
  { snapshotCompleted: true, snapshotTimedOut: false },
  { snapshotCompleted: false, snapshotTimedOut: true },
])(
  '[AC-B2-04o#20] SB8 两个开关 on 且快照完成或超时可继续 %j，只改批次不执行订单',
  async (snapshot) => {
    const h = await fixture(database.db);
    const b = await seedBatch(h, { status: 'PARTIAL', platform: 'jd', started_at: new Date(PAST) });
    await seedItem(h, b);
    h.readiness.mockResolvedValue({ autoEnabled: true, creditEnabled: true, ...snapshot });
    const before = await untouched(h);
    await h.service().resumeBatch(command(h, b));
    expect(await stored(h, b)).toMatchObject({
      status: 'EXECUTING',
      row_version: 5,
      confirmed_by: b.confirmed_by,
      confirmed_at: b.confirmed_at,
    });
    expect(h.readiness).toHaveBeenCalledWith({ appId: h.appId, platform: 'jd', at: new Date(NOW) });
    expect(await untouched(h)).toEqual(before);
  },
);

it.each([
  { autoEnabled: false, creditEnabled: true },
  { autoEnabled: true, creditEnabled: false },
  { autoEnabled: false, creditEnabled: false },
])('[AC-B2-04o#21] SB8 任一开关 off 拒绝且保留 PARTIAL %j', async (switches) => {
  const h = await fixture(database.db);
  const b = await seedBatch(h, { status: 'PARTIAL' });
  h.readiness.mockResolvedValue({ ...switches, snapshotCompleted: true, snapshotTimedOut: true });
  await rejectedUnchanged(h, () => h.service().resumeBatch(command(h, b)), {
    name: 'BatchCommandRejected',
    reason: 'switches_off',
  });
});

it('[AC-B2-04o#22] SB8 当日快照未完成且未超时拒绝；跨日后使用新的 Clock 时刻查询', async () => {
  const h = await fixture(database.db);
  const b = await seedBatch(h, { status: 'PARTIAL' });
  const service = h.service();
  h.clock.set('2032-07-25T00:00:00+08:00');
  h.readiness.mockResolvedValue({
    autoEnabled: true,
    creditEnabled: true,
    snapshotCompleted: false,
    snapshotTimedOut: false,
  });
  await rejectedUnchanged(h, () => service.resumeBatch(command(h, b)), {
    name: 'BatchCommandRejected',
    reason: 'snapshot_pending',
  });
  expect(h.readiness).toHaveBeenCalledWith({
    appId: h.appId,
    platform: b.platform,
    at: h.clock.now(),
  });
});

it('[AC-B2-04o#23] 开关恢复不自动续跑；再次人工继续才从 PARTIAL 迁移', async () => {
  const h = await fixture(database.db);
  const b = await seedBatch(h, { status: 'PARTIAL' });
  const service = h.service();
  h.readiness.mockResolvedValue({
    autoEnabled: false,
    creditEnabled: true,
    snapshotCompleted: true,
    snapshotTimedOut: false,
  });
  await rejectedUnchanged(h, () => service.resumeBatch(command(h, b)), {
    name: 'BatchCommandRejected',
    reason: 'switches_off',
  });
  h.readiness.mockResolvedValue({
    autoEnabled: true,
    creditEnabled: true,
    snapshotCompleted: true,
    snapshotTimedOut: false,
  });
  expect(await stored(h, b)).toEqual(b);
  await service.resumeBatch(command(h, b));
  expect(await stored(h, b)).toMatchObject({ status: 'EXECUTING', row_version: 5 });
});

it.each(STATES.filter((s) => s !== 'PARTIAL'))(
  '[AC-B2-04o#24] SB8 %s 不可继续执行',
  async (status) => {
    const h = await fixture(database.db);
    const b = await seedBatch(h, { status });
    await rejectedUnchanged(h, () => h.service().resumeBatch(command(h, b)), {
      name: 'IllegalTransition',
    });
  },
);

it.each(STATES)(
  '[AC-B2-04o#25] SB10 在 %s 恒拒，即使开关 on、快照完成、带停住标记且已过定时时刻',
  async (status) => {
    const h = await fixture(database.db);
    const b = await seedBatch(h, {
      status,
      settle_mode: 'SCHEDULED',
      scheduled_at: new Date(PAST),
      paused_by_switch_at: new Date(PAST),
    });
    await seedItem(h, b);
    await rejectedUnchanged(h, () => h.service().manualStart(command(h, b)), {
      name: 'IllegalTransition',
    });
  },
);

it.each(['cancelSchedule', 'rejectBatch', 'resumeBatch', 'manualStart'] as const)(
  '[AC-B2-04o#26] %s 不能用别的 app 的 batch_id 修改批次',
  async (method) => {
    const h = await fixture(database.db);
    const other = await fixture(database.db);
    const status =
      method === 'rejectBatch' ? 'DRAFT' : method === 'resumeBatch' ? 'PARTIAL' : 'CONFIRMED';
    const b = await seedBatch(other, {
      status,
      settle_mode: 'SCHEDULED',
      scheduled_at: new Date(FUTURE),
    });
    const before = await state(other);
    await rejectedUnchanged(
      h,
      () => {
        const service = h.service();
        const input = command(h, b);
        return method === 'rejectBatch'
          ? service.rejectBatch({ ...input, reason: '跨应用' })
          : service[method](input);
      },
      method === 'manualStart'
        ? { name: 'IllegalTransition' }
        : { name: 'BatchCommandRejected', reason: 'batch_not_found' },
    );
    expect(await state(other)).toEqual(before);
  },
);
