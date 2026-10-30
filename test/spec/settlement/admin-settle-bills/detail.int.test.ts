// B2-09d bill detail rule tests (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// getAdminSettleBill (GET /admin/v1/settle-bills/{bill_id}: settle.bill or fund.view, read only,
// no step-up; the fields of a list row plus `batches`: every settle_batches row of the bill, main
// and supplement, CANCELLED included, ordered by created_at then batch_id, each with its columns,
// in_current_round (the bill's latest round as AdminSettleBillStatus defines it) and item_counts
// summed at read time by item_type × result; a bill_id off the pattern, or no bill of the app for
// it → 20001 data.fields=[bill_id], no 404; reading writes no audit record); the derived status
// (08 BR-FUND-04 细则「月结账单状态」), switching rounds when a supplement batch is launched,
// rejected or executed. Requests go through the real admin entry (kit.ts). Top-level it() only
// (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  BATCH_KEYS,
  DETAIL_KEYS,
  GENERATING,
  VIEW,
  ago,
  allAudits,
  answer,
  batchView,
  billView,
  counts,
  detailOf,
  finish,
  fixture,
  footprint,
  inDetailOrder,
  later,
  normalize,
  page,
  reject,
  rounds,
  seedBatch,
  seedBeneficiaryItem,
  seedBill,
  seedMember,
  seedOrderItem,
  statuses,
  suite,
  withSettleAdmin,
  type BatchRow,
  type BatchSeed,
} from './kit.ts';

const s = suite();
const DAY = 24 * 60;

it('[AC-B2-09d#10] 账单详情（settle.bill 或 fund.view 任一即可，超管也能读）：恰好是契约的 AdminSettleBillDetail——列表行的字段加 batches：该账单的全部批次（首批与补充、含驳回的），按 created_at、再按 batch_id 升序，每个批次的列原样、in_current_round 只在最近一轮为 true、item_counts 按 item_type × result 读时汇总（pending = 未执行）；详情的列表字段与列表行一致；其他应用同一账单月的批次与明细不出现、不计入计数与派生状态；读取不写审计、不改三张表', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09', {
    generation_started_at: ago(f, 5 * DAY + 15),
    generated_at: ago(f, 5 * DAY),
  });
  const other = await seedBill(f, '2026-08');
  // Another app's bill of the same month: a main batch executed (confirmed_by that app's admin)
  // and a later supplement launch waiting for confirmation, both with items. Read by bill_id
  // alone, they would join this bill's batches, counts and round (the status would turn issued).
  const foreignApp = fixture(s);
  const foreignBill = await seedBill(foreignApp, '2026-09', {
    generation_started_at: ago(foreignApp, 5 * DAY + 15),
    generated_at: ago(foreignApp, 5 * DAY),
  });
  const foreignMain = await seedBatch(foreignApp, foreignBill, { status: 'DONE' });
  await seedOrderItem(foreignApp, foreignMain, { result: 'credited' });
  const foreignLatest = await seedBatch(foreignApp, foreignBill, {
    kind: 'supplement',
    created_at: ago(foreignApp, DAY),
  });
  await seedOrderItem(foreignApp, foreignLatest);
  await withSettleAdmin(f, async (h) => {
    const member = await seedMember(f, h.crypto);
    // The bill-day task: taobao executed, jd rejected; both created at the same instant.
    const mainTaobao = await seedBatch(f, bill, { status: 'DONE', order_count: 4 });
    const mainJd = await seedBatch(f, bill, { platform: 'jd', status: 'CANCELLED' });
    for (const result of ['credited', 'credited', 'skipped', null] as const) {
      await seedOrderItem(f, mainTaobao, { result });
    }
    await seedBeneficiaryItem(f, mainTaobao, member, { result: 'credited', amount_fen: 36n });
    await seedBeneficiaryItem(f, mainTaobao, member, { result: 'skipped', role: 'self' });
    await seedBeneficiaryItem(f, mainTaobao, member, { result: 'deferred', role: 'share' });
    await seedBeneficiaryItem(f, mainTaobao, member, { role: 'indirect' });
    // A supplement launch three days ago, executed.
    const first = await seedBatch(f, bill, {
      kind: 'supplement',
      status: 'DONE',
      created_at: ago(f, 3 * DAY),
    });
    await seedOrderItem(f, first, { result: 'credited' });
    // The latest launch two days ago: confirmed for a scheduled settlement an hour from now.
    const latest = await seedBatch(f, bill, {
      kind: 'supplement',
      status: 'CONFIRMED',
      settle_mode: 'SCHEDULED',
      scheduled_at: later(f, 60),
      order_count: 2,
      created_at: ago(f, 2 * DAY),
    });
    await seedOrderItem(f, latest);
    await seedOrderItem(f, latest);
    await seedBeneficiaryItem(f, latest, member);
    // Another bill's batch and items do not count here.
    const elsewhere = await seedBatch(f, other, { status: 'DONE' });
    await seedOrderItem(f, elsewhere, { result: 'credited' });

    const itemCounts = new Map([
      [
        mainTaobao.batch_id,
        counts({
          order: { credited: 2, skipped: 1, pending: 1 },
          beneficiary: { credited: 1, skipped: 1, deferred: 1, pending: 1 },
        }),
      ],
      [mainJd.batch_id, counts()],
      [first.batch_id, counts({ order: { credited: 1 } })],
      [latest.batch_id, counts({ order: { pending: 2 }, beneficiary: { pending: 1 } })],
    ]);
    const all = [mainTaobao, mainJd, first, latest];
    const expected = {
      ...billView(bill, 'scheduled', all),
      batches: inDetailOrder(all).map((b) =>
        batchView(b, b.batch_id === latest.batch_id, itemCounts.get(b.batch_id)),
      ),
    };
    const before = await footprint(f);
    const foreignBefore = await footprint(foreignApp);
    const root = await h.caller([], { superAdmin: true });
    for (const who of [h.biller, h.viewer, root]) {
      const sent = await h.detail(bill.bill_id, who);
      const data = await detailOf(sent);
      expect(Object.keys(data).sort(), sent.body).toEqual(DETAIL_KEYS);
      for (const b of data['batches'] as Record<string, unknown>[]) {
        expect(Object.keys(b).sort(), sent.body).toEqual([...BATCH_KEYS]);
      }
      // Exactly this app's batches, counts and status: none of the other app's same-month bill.
      expect(data, sent.body).toEqual(expected);
    }
    // The list row of the bill is the detail without its batches.
    const listed = await page(await h.list({ bill_from: '2026-09' }));
    expect(listed.items.map(normalize)).toEqual([billView(bill, 'scheduled', all)]);
    expect(await footprint(f)).toEqual(before);
    expect(await footprint(foreignApp)).toEqual(foreignBefore);
  });
  expect(await allAudits(f)).toEqual([]);
  expect(await allAudits(foreignApp)).toEqual([]);
});

it('[AC-B2-09d#11] 账单状态各分支（详情与列表一致，不存不写）：generating（生成中，即使已有批次）；issued（DRAFT、无批次、全部被驳回）；scheduled（定时未到）；settling（EXECUTING、PARTIAL、CONFIRMED 立即结算、定时已过）；settled（全部 DONE，驳回的不算）；时钟走到定时时刻（不晚于当前时刻）即转为 settling，三张表不变', async () => {
  const f = fixture(s);
  const bills = new Map<string, { status: string; batches: BatchRow[] }>();
  const add = async (month: string, status: string, seeds: BatchSeed[], generating = false) => {
    const bill = await seedBill(f, month, generating ? GENERATING : {});
    const batches: BatchRow[] = [];
    for (const [index, seed] of seeds.entries()) {
      const platform = ['taobao', 'jd', 'pdd'][index]!;
      batches.push(await seedBatch(f, bill, { platform, ...seed }));
    }
    bills.set(month, { status, batches });
  };
  const due = later(f, 5);
  await add('2025-01', 'generating', [{}], true);
  await add('2025-02', 'issued', [{}, { status: 'CONFIRMED' }]);
  await add('2025-03', 'issued', []);
  await add('2025-04', 'issued', [{ status: 'CANCELLED' }, { status: 'CANCELLED' }]);
  await add('2025-05', 'scheduled', [
    { status: 'CONFIRMED', settle_mode: 'SCHEDULED', scheduled_at: due },
    { status: 'DONE' },
  ]);
  await add('2025-06', 'settling', [{ status: 'EXECUTING' }]);
  await add('2025-07', 'settling', [{ status: 'PARTIAL' }, { status: 'DONE' }]);
  await add('2025-08', 'settling', [{ status: 'CONFIRMED', settle_mode: 'IMMEDIATE' }]);
  await add('2025-09', 'settling', [
    { status: 'CONFIRMED', settle_mode: 'SCHEDULED', scheduled_at: ago(f, 1) },
  ]);
  await add('2025-10', 'settled', [
    { status: 'DONE' },
    { status: 'DONE' },
    { status: 'CANCELLED' },
  ]);
  const want = Object.fromEntries([...bills].map(([month, b]) => [month, b.status]));
  const before = await footprint(f);
  await withSettleAdmin(f, async (h) => {
    expect(await statuses(await h.list())).toEqual(want);
    for (const [month, b] of bills) {
      const data = await detailOf(await h.detail(month, h.viewer));
      expect({ month, status: data['status'] }).toEqual({ month, status: b.status });
      expect({
        month,
        batch_count: data['batch_count'],
        draft_batch_count: data['draft_batch_count'],
      }).toEqual({
        month,
        batch_count: b.batches.length,
        draft_batch_count: b.batches.filter((x) => x.status === 'DRAFT').length,
      });
    }
    f.clock.set(due);
    expect((await detailOf(await h.detail('2025-05')))['status']).toBe('settling');
    expect(await statuses(await h.list())).toEqual({ ...want, '2025-05': 'settling' });
  });
  expect(await footprint(f)).toEqual(before);
});

it('[AC-B2-09d#12] 首轮与补充轮的切换：首轮全部 DONE 为 settled；发起补充批次（更晚的 created_at）后只看补充轮——DRAFT 为 issued，被驳回仍在本轮（in_current_round 为 true）且回到 issued；再次发起的补充轮取代它，立即结算为 settling、执行完为 settled；in_current_round 只标最近一轮的批次', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09', {
    generation_started_at: ago(f, 6 * DAY + 10),
    generated_at: ago(f, 6 * DAY),
  });
  const mainTaobao = await seedBatch(f, bill, { status: 'DONE' });
  const mainJd = await seedBatch(f, bill, {
    platform: 'jd',
    status: 'DONE',
    created_at: ago(f, 6 * DAY - 1),
  });
  await withSettleAdmin(f, async (h) => {
    const step = async (name: string, status: string, current: readonly BatchRow[]) => {
      const data = await detailOf(await h.detail(bill.bill_id));
      expect({ name, status: data['status'] }).toEqual({ name, status });
      const ids = new Set(current.map((b) => b.batch_id));
      const flags = rounds(data);
      expect({ name, flags }).toEqual({
        name,
        flags: Object.fromEntries(Object.keys(flags).map((id) => [id, ids.has(id)])),
      });
      expect(Object.values(flags).filter((v) => v === true)).toHaveLength(ids.size);
      expect(await statuses(await h.list())).toEqual({ [bill.bill_id]: status });
    };
    await step('main round settled', 'settled', [mainTaobao, mainJd]);

    const first = await seedBatch(f, bill, { kind: 'supplement', created_at: ago(f, 3 * DAY) });
    await step('supplement waiting for confirmation', 'issued', [first]);

    const rejected = await reject(f, first);
    await step('supplement rejected', 'issued', [rejected]);

    const second = await seedBatch(f, bill, {
      kind: 'supplement',
      status: 'CONFIRMED',
      settle_mode: 'IMMEDIATE',
      created_at: ago(f, DAY),
    });
    await step('second supplement confirmed', 'settling', [second]);

    await finish(f, second);
    await step('second supplement executed', 'settled', [second]);

    const data = await detailOf(await h.detail(bill.bill_id));
    expect((data['batches'] as Record<string, unknown>[]).map((b) => b['batch_id'])).toEqual(
      inDetailOrder([mainTaobao, mainJd, first, second]).map((b) => b.batch_id),
    );
  });
});

it('[AC-B2-09d#13] 账单详情的拒绝：bill_id 不是 YYYY-MM（13 月、00 月、一位月份、带日、无连字符）→ 20001 data.fields=[bill_id]；本应用没有该账单月（不存在，或只有其他应用有）→ 20001 [bill_id]（不回 404，应答一样）；没有 settle.bill / fund.view → 10403；不带令牌 → 10001；读取不写审计', async () => {
  const f = fixture(s);
  const other = fixture(s);
  const own = await seedBill(f, '2026-09');
  await seedBill(other, '2026-08');
  await withSettleAdmin(f, async (h) => {
    const refusals: unknown[] = [];
    for (const billId of ['2026-08', '2026-10', '1999-01']) {
      const body = await answer(await h.detail(billId), 20001, { fields: ['bill_id'] });
      refusals.push({ code: body.code, msg: body.msg, data: body.data });
      await answer(await h.detail(billId, h.viewer), 20001, { fields: ['bill_id'] });
    }
    expect(new Set(refusals.map((refusal) => JSON.stringify(refusal))).size).toBe(1);
    for (const billId of ['2026-13', '2026-00', '2026-9', '2026-09-01', '202609']) {
      await answer(await h.detail(billId), 20001, { fields: ['bill_id'] });
    }
    await answer(await h.detail(own.bill_id, await h.caller([])), 10403);
    await answer(await h.detail(own.bill_id, await h.caller(['fund.recon'])), 10403);
    await answer(await h.detail(own.bill_id, await h.caller(['settle.statement_upload'])), 10403);
    await answer(await h.detail(own.bill_id, null), 10001);
    const data = await detailOf(await h.detail(own.bill_id, await h.caller([VIEW])));
    const shown = { bill_id: data['bill_id'], status: data['status'], batches: data['batches'] };
    expect(shown).toEqual({ bill_id: own.bill_id, status: 'issued', batches: [] });
  });
  expect(await allAudits(f)).toEqual([]);
});
