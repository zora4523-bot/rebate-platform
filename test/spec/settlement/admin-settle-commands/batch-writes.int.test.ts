// B2-09f single-batch write rule tests (claude-independent, SPEC_REF 37808a50):
// contracts/openapi.yaml cancelAdminSettleBatchSchedule (SB3: only CONFIRMED + SCHEDULED, not
// started; to DRAFT, confirmed_by / confirmed_at / scheduled_at cleared, settle_mode IMMEDIATE,
// paused_by_switch_at stays), rejectAdminSettleBatch (SB4: only DRAFT; reason 1–200 characters
// after trimming, stored trimmed as cancelled_reason; orders, items and ledger untouched) and
// resumeAdminSettleBatch (SB8: only PARTIAL; status only, started_at and paused_by_switch_at stay;
// then the guard, 20001 [batch_id] with data.reason switches_off / snapshot_pending, the batch stays
// PARTIAL). Order after the guard: body → batch_id → 20902 resource=settle_batch → the SB8 guard.
// row_version + 1 by compare-and-set; audit; the response is the bill as GET returns it afterwards.
// The switches are read as the executor reads them: settle.auto.enabled defaults on, a missing
// credit.enabled.<platform> is off; the asset snapshot is the one of the day before the +08:00
// calendar day (BR-FUND-18, deadline D+1 00:30). Requests go through the real admin entry (kit.ts).
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  AUTO_SWITCH,
  CANCEL_ACTION,
  REJECT_ACTION,
  RESUME_ACTION,
  ago,
  answer,
  audits,
  auditText,
  batchNow,
  billOf,
  conflict,
  creditSwitch,
  everything,
  fixture,
  instantsIn,
  oneAudit,
  pastConfigCache,
  refused,
  seedAssetSnapshot,
  seedBatch,
  seedBill,
  seedItemOf,
  seedOrder,
  setSwitch,
  suite,
  versionOf,
  withCommandsAdmin,
  type BatchRow,
  type BatchSeed,
  type Fixture,
} from './kit.ts';

const s = suite();
const MIDNIGHT_PAST_TEN = '2026-10-30T00:10:00+08:00';
const MIDNIGHT_PAST_FORTY = '2026-10-30T00:40:00+08:00';
const SNAPSHOT_DAY = '2026-10-29';
const UNKNOWN_BATCH = '00000000-0000-7000-8000-000000000000';

/** The batches that are not `status`-eligible for a command, each on a bill of its own. */
async function others(f: Fixture, seeds: readonly BatchSeed[]): Promise<BatchRow[]> {
  const rows: BatchRow[] = [];
  for (const [index, seed] of seeds.entries()) {
    const month = String(index + 1).padStart(2, '0');
    rows.push(await seedBatch(f, await seedBill(f, `2025-${month}`), seed));
  }
  return rows;
}

it('[AC-B2-09f#16] 撤销定时（SB3）：CONFIRMED + SCHEDULED、未开始的批次回到 DRAFT，row_version +1，确认人、确认时间、定时时间清空，settle_mode 回 IMMEDIATE，paused_by_switch_at 保留，其余列不变；同账单别的批次不动；响应恰好是之后 GET 详情的内容，账单回到 issued；审计 settle_batch_cancel_schedule 含批次与前后的 status、settle_mode、scheduled_at', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const paused = ago(f, 5);
  const batch = await seedBatch(f, bill, {
    status: 'CONFIRMED',
    settle_mode: 'SCHEDULED',
    row_version: 4,
    order_count: 7,
    paused_by_switch_at: paused,
  });
  const sibling = await seedBatch(f, bill, {
    platform: 'jd',
    status: 'CONFIRMED',
    settle_mode: 'SCHEDULED',
  });
  await withCommandsAdmin(f, async (h) => {
    const data = await billOf(await h.cancelSchedule(batch.batch_id, versionOf(batch)));
    expect(await batchNow(f, batch)).toEqual({
      ...batch,
      status: 'DRAFT',
      settle_mode: 'IMMEDIATE',
      scheduled_at: null,
      confirmed_by: null,
      confirmed_at: null,
      row_version: 5,
    });
    expect(await batchNow(f, sibling)).toEqual(sibling);
    expect(data['status']).toBe('issued');
    expect(data['draft_batch_count']).toBe(1);
    expect(await billOf(await h.detail(bill.bill_id))).toEqual(data);

    const record = await oneAudit(f, CANCEL_ACTION, h.biller.id);
    expect(auditText(record)).toContain(batch.batch_id);
    expect(record.before).toMatchObject({ status: 'CONFIRMED', settle_mode: 'SCHEDULED' });
    expect(record.after).toMatchObject({
      status: 'DRAFT',
      settle_mode: 'IMMEDIATE',
      scheduled_at: null,
    });
    expect(instantsIn(JSON.stringify(record.before))).toContain(batch.scheduled_at!.getTime());
  });
});

it('[AC-B2-09f#17] 撤销定时的拒绝：立即结算的 CONFIRMED、已开始（started_at 有值）的 CONFIRMED、DRAFT、EXECUTING、PARTIAL、DONE、CANCELLED、版本过期 → 20902 data.resource=settle_batch；重复提交 → 20902；什么都不变、不写审计', async () => {
  const f = fixture(s);
  const scheduled = { status: 'CONFIRMED', settle_mode: 'SCHEDULED' } as const;
  const rows = await others(f, [
    { status: 'CONFIRMED', settle_mode: 'IMMEDIATE' },
    { ...scheduled, started_at: ago(f, 1) },
    { status: 'DRAFT' },
    { status: 'EXECUTING' },
    { status: 'PARTIAL' },
    { status: 'DONE' },
    { status: 'CANCELLED' },
  ]);
  const stale = await seedBatch(f, await seedBill(f, '2026-09'), { ...scheduled, row_version: 2 });
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    for (const row of rows) await conflict(await h.cancelSchedule(row.batch_id, versionOf(row)));
    for (const version of [1, 3]) {
      await conflict(await h.cancelSchedule(stale.batch_id, { expected_row_version: version }));
    }
    expect(await everything(f)).toEqual(before);
    await answer(await h.cancelSchedule(stale.batch_id, versionOf(stale)), 0);
    await conflict(await h.cancelSchedule(stale.batch_id, versionOf(stale)));
    expect(await audits(f, CANCEL_ACTION)).toHaveLength(1);
  });
});

it('[AC-B2-09f#18] 驳回（SB4）：DRAFT 到 CANCELLED（终态），row_version +1，cancelled_reason 是去掉首尾空白的原因，其余列不变；批内订单保持 WAITING，明细、账务、账单合计不动；响应恰好是之后 GET 详情的内容；审计 settle_batch_reject 含批次、原因与前后的 status', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const batch = await seedBatch(f, bill, { row_version: 3 });
  const sibling = await seedBatch(f, bill, { platform: 'jd' });
  await seedItemOf(f, batch, await seedOrder(f));
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    const data = await billOf(
      await h.reject(batch.batch_id, { ...versionOf(batch), reason: '  联盟结算数据待核对 \n' }),
    );
    expect(await batchNow(f, batch)).toEqual({
      ...batch,
      status: 'CANCELLED',
      cancelled_reason: '联盟结算数据待核对',
      row_version: 4,
    });
    expect(await batchNow(f, sibling)).toEqual(sibling);
    const after = await everything(f);
    for (const part of ['bills', 'items', 'orders', 'vouchers', 'balances'] as const) {
      expect(after[part]).toEqual(before[part]);
    }
    expect(after.orders.map((order) => order.rebate_status)).toEqual(['WAITING']);
    expect(await billOf(await h.detail(bill.bill_id))).toEqual(data);

    const record = await oneAudit(f, REJECT_ACTION, h.biller.id);
    expect(auditText(record)).toContain(batch.batch_id);
    expect(auditText(record)).toContain('联盟结算数据待核对');
    expect(record.before).toMatchObject({ status: 'DRAFT' });
    expect(record.after).toMatchObject({ status: 'CANCELLED' });
  });
});

it('[AC-B2-09f#19] 驳回原因：恰好 200 字可以驳回；去空白后为空、超过 200 字、缺失 → 20001 data.fields=[reason]，全空白的原因先于 batch_id；缺 expected_row_version → [expected_row_version]；什么都不变、不写审计', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const batch = await seedBatch(f, bill);
  const version = versionOf(batch);
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    for (const reason of ['   ', ' \t\n ', '', '差'.repeat(201)]) {
      await refused(await h.reject(batch.batch_id, { ...version, reason }), ['reason']);
    }
    await refused(await h.reject(batch.batch_id, version), ['reason']);
    await refused(await h.reject(UNKNOWN_BATCH, { ...version, reason: ' ' }), ['reason']);
    await refused(await h.reject(batch.batch_id, { reason: '驳回' }), ['expected_row_version']);
    expect(await everything(f)).toEqual(before);

    await answer(await h.reject(batch.batch_id, { ...version, reason: '差'.repeat(200) }), 0);
    expect((await batchNow(f, batch)).cancelled_reason).toBe('差'.repeat(200));
  });
});

it('[AC-B2-09f#20] 驳回的拒绝：CONFIRMED（立即与定时）、EXECUTING、PARTIAL、DONE、CANCELLED、版本过期 → 20902 data.resource=settle_batch（已确认的批次不能取消）；两个请求同时驳回同一批次 → 恰好一个成功；什么都不变的情形不写审计', async () => {
  const f = fixture(s);
  const rows = await others(f, [
    { status: 'CONFIRMED', settle_mode: 'IMMEDIATE' },
    { status: 'CONFIRMED', settle_mode: 'SCHEDULED' },
    { status: 'EXECUTING' },
    { status: 'PARTIAL' },
    { status: 'DONE' },
    { status: 'CANCELLED' },
  ]);
  const bill = await seedBill(f, '2026-09');
  const stale = await seedBatch(f, bill, { row_version: 2 });
  const contested = await seedBatch(f, bill, { platform: 'jd' });
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    for (const row of rows) {
      await conflict(await h.reject(row.batch_id, { ...versionOf(row), reason: '驳回' }));
    }
    for (const expected_row_version of [1, 3]) {
      await conflict(await h.reject(stale.batch_id, { expected_row_version, reason: '驳回' }));
    }
    expect(await everything(f)).toEqual(before);

    const body = { ...versionOf(contested), reason: '同时驳回' };
    const replies = await Promise.all([
      h.reject(contested.batch_id, body),
      h.reject(contested.batch_id, body),
    ]);
    expect(replies.map((sent) => sent.json().code).sort((x, y) => x - y)).toEqual([0, 20902]);
    expect((await batchNow(f, contested)).row_version).toBe(1);
    expect(await audits(f, REJECT_ACTION)).toHaveLength(1);
  });
});

it('[AC-B2-09f#21] 继续执行（SB8）：两个开关为 on（settle.auto.enabled 未配置按默认 on），PARTIAL 到 EXECUTING，row_version +1，只改状态：started_at、finished_at、paused_by_switch_at、确认信息都不动；明细与账务不动（由执行器续跑）；响应恰好是之后 GET 详情的内容；审计 settle_batch_resume 含批次与前后的 status', async () => {
  const f = fixture(s);
  await setSwitch(f, creditSwitch('jd'), true);
  const bill = await seedBill(f, '2026-09');
  const batch = await seedBatch(f, bill, {
    platform: 'jd',
    status: 'PARTIAL',
    row_version: 3,
    paused_by_switch_at: ago(f, 15),
  });
  await seedItemOf(f, batch, await seedOrder(f, { platform: 'jd' }));
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    const data = await billOf(await h.resume(batch.batch_id, versionOf(batch)));
    expect(await batchNow(f, batch)).toEqual({ ...batch, status: 'EXECUTING', row_version: 4 });
    const after = await everything(f);
    for (const part of ['bills', 'items', 'orders', 'vouchers', 'balances'] as const) {
      expect(after[part]).toEqual(before[part]);
    }
    expect(await billOf(await h.detail(bill.bill_id))).toEqual(data);

    const record = await oneAudit(f, RESUME_ACTION, h.biller.id);
    expect(auditText(record)).toContain(batch.batch_id);
    expect(record.before).toMatchObject({ status: 'PARTIAL' });
    expect(record.after).toMatchObject({ status: 'EXECUTING' });
  });
});

it('[AC-B2-09f#22] 继续执行的开关守卫：settle.auto.enabled 为 off、该平台 credit.enabled 未配置或为 off → 20001 data.fields=[batch_id] data.reason=switches_off，批次保持 PARTIAL、不写审计；别的平台的 credit.enabled 为 on 不算数；开关恢复后才放行', async () => {
  const f = fixture(s);
  await setSwitch(f, creditSwitch('taobao'), true);
  const bill = await seedBill(f, '2026-09');
  const batch = await seedBatch(f, bill, { platform: 'jd', status: 'PARTIAL', row_version: 1 });
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    const blocked = async () => {
      await refused(await h.resume(batch.batch_id, versionOf(batch)), ['batch_id'], 'switches_off');
      expect(await everything(f)).toEqual(before);
    };
    await blocked();

    await setSwitch(f, creditSwitch('jd'), false);
    pastConfigCache(f);
    await blocked();

    await setSwitch(f, creditSwitch('jd'), true);
    await setSwitch(f, AUTO_SWITCH, false);
    pastConfigCache(f);
    await blocked();

    await setSwitch(f, AUTO_SWITCH, true);
    pastConfigCache(f);
    await answer(await h.resume(batch.batch_id, versionOf(batch)), 0);
    expect((await batchNow(f, batch)).status).toBe('EXECUTING');
  });
});

it('[AC-B2-09f#23] 继续执行的快照守卫：当日快照（前一会计日 D 的快照）未完成也未超时 → 20001 data.fields=[batch_id] data.reason=snapshot_pending，批次保持 PARTIAL、不写审计；D 的快照完成后放行', async () => {
  const f = fixture(s, MIDNIGHT_PAST_TEN);
  await setSwitch(f, creditSwitch('taobao'), true);
  const batch = await seedBatch(f, await seedBill(f, '2026-09'), { status: 'PARTIAL' });
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    await refused(
      await h.resume(batch.batch_id, versionOf(batch)),
      ['batch_id'],
      'snapshot_pending',
    );
    expect(await everything(f)).toEqual(before);

    await seedAssetSnapshot(f, SNAPSHOT_DAY);
    await answer(await h.resume(batch.batch_id, versionOf(batch)), 0);
    expect((await batchNow(f, batch)).status).toBe('EXECUTING');
  });
});

it('[AC-B2-09f#24] 继续执行的快照超时：D 的快照始终没写、时钟过了 D+1 00:30 → 算已超时，放行（BR-FUND-18）', async () => {
  const f = fixture(s, MIDNIGHT_PAST_FORTY);
  await setSwitch(f, creditSwitch('taobao'), true);
  const batch = await seedBatch(f, await seedBill(f, '2026-09'), { status: 'PARTIAL' });
  await withCommandsAdmin(f, async (h) => {
    await answer(await h.resume(batch.batch_id, versionOf(batch)), 0);
    expect((await batchNow(f, batch)).status).toBe('EXECUTING');
  });
});

it('[AC-B2-09f#25] 继续执行的冲突先于守卫：DRAFT、CONFIRMED、EXECUTING、DONE、CANCELLED、版本过期 → 20902 data.resource=settle_batch，即使开关为 off、快照未完成也不报 20001；重复提交 → 20902；不写审计', async () => {
  const f = fixture(s, MIDNIGHT_PAST_TEN);
  await setSwitch(f, AUTO_SWITCH, false);
  const rows = await others(f, [
    { status: 'DRAFT' },
    { status: 'CONFIRMED' },
    { status: 'EXECUTING' },
    { status: 'DONE' },
    { status: 'CANCELLED' },
  ]);
  const stale = await seedBatch(f, await seedBill(f, '2026-09'), {
    status: 'PARTIAL',
    row_version: 2,
  });
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    for (const row of rows) await conflict(await h.resume(row.batch_id, versionOf(row)));
    for (const expected_row_version of [1, 3]) {
      await conflict(await h.resume(stale.batch_id, { expected_row_version }));
    }
    expect(await everything(f)).toEqual(before);

    await setSwitch(f, AUTO_SWITCH, true);
    await setSwitch(f, creditSwitch('taobao'), true);
    await seedAssetSnapshot(f, SNAPSHOT_DAY);
    pastConfigCache(f);
    await answer(await h.resume(stale.batch_id, versionOf(stale)), 0);
    await conflict(await h.resume(stale.batch_id, versionOf(stale)));
    expect(await audits(f, RESUME_ACTION)).toHaveLength(1);
  });
});

it('[AC-B2-09f#26] 版本请求体（cancel-schedule 与 resume）：缺 expected_row_version、为负、不是整数、是字符串 → 20001 data.fields=[expected_row_version]，先于 batch_id；未知字段 → 该字段；什么都不变', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const scheduled = await seedBatch(f, bill, { status: 'CONFIRMED', settle_mode: 'SCHEDULED' });
  const partial = await seedBatch(f, bill, { platform: 'jd', status: 'PARTIAL' });
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    const sends = [
      (body: unknown) => h.cancelSchedule(scheduled.batch_id, body),
      (body: unknown) => h.resume(partial.batch_id, body),
      (body: unknown) => h.cancelSchedule(UNKNOWN_BATCH, body),
      (body: unknown) => h.resume(UNKNOWN_BATCH, body),
    ];
    for (const send of sends) {
      for (const body of [
        {},
        { expected_row_version: -1 },
        { expected_row_version: 1.5 },
        { expected_row_version: '1' },
      ]) {
        await refused(await send(body), ['expected_row_version']);
      }
      await refused(await send({ expected_row_version: 0, note: '备注' }), ['note']);
    }
    expect(await everything(f)).toEqual(before);
  });
});
