// B2-09d bill list rule tests (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// listAdminSettleBills (GET /admin/v1/settle-bills: settle.bill or fund.view, read only, no
// step-up; one row per settle_bills row of the console's app with the derived status
// (AdminSettleBillStatus, 08 BR-FUND-04 细则「月结账单状态」, not stored), the bill-day totals as
// stored (supplement batches do not write them back, D10-280 ③), batch_count / draft_batch_count
// counted at read time; filters bill_from / bill_to (inclusive) and status (derived at response
// time, the injected clock) combine with AND; a value outside the enum or pattern → 20001
// data.fields naming it; bill_from later than bill_to → 20001 data.fields=[bill_from, bill_to];
// bill_id descending; a page past the last → items=[]; page_size ≤ 200; total = count of the filter
// set; reading writes no audit record). Requests go through the real admin entry (kit.ts).
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  BILL,
  BILL_KEYS,
  GENERATING,
  VIEW,
  ago,
  allAudits,
  answer,
  billIds,
  billView,
  fixture,
  footprint,
  later,
  normalize,
  page,
  seedBatch,
  seedBill,
  seedOrderItem,
  statuses,
  suite,
  withSettleAdmin,
  type BatchRow,
  type Fixture,
} from './kit.ts';

const s = suite();
/** 2^53 − 1: the largest fen amount a JSON number carries exactly. */
const BIG = 9_007_199_254_740_991n;
const DAY = 24 * 60;

it('[AC-B2-09d#4] 月结账单列表（settle.bill 或 fund.view 任一即可，不要 step-up；两点都有、超管也能读）：只列本应用的账单，按 bill_id 倒序，每行恰好是契约的 AdminSettleBill——账单列原样、派生 status、batch_count（含驳回的批次）与 draft_batch_count 读时计数；其他应用的账单（含同一账单月）不出现；默认 page 1 / page_size 20；读取不写审计、不改三张表', async () => {
  const f = fixture(s);
  const other = fixture(s);
  const generating = await seedBill(f, '2026-09', {
    ...GENERATING,
    generation_started_at: ago(f, 30),
  });
  const issued = await seedBill(f, '2026-08', {
    platform_order_counts: { taobao: 1200, jd: 300 },
    platform_settle_commission_totals: { taobao: 864_000, jd: 151_000 },
    beneficiary_total_fen: 712_000n,
    platform_retained_fen: 303_000n,
    error_count: 4,
    held_count: 2,
    generation_started_at: ago(f, 6 * DAY),
    generated_at: ago(f, 6 * DAY - 12),
  });
  const issuedBatches = [
    await seedBatch(f, issued),
    await seedBatch(f, issued, { platform: 'jd' }),
    await seedBatch(f, issued, { platform: 'pdd', status: 'CANCELLED' }),
  ];
  const settled = await seedBill(f, '2026-07', {
    platform_order_counts: { taobao: 980 },
    platform_settle_commission_totals: { taobao: 702_500 },
    beneficiary_total_fen: 491_750n,
    platform_retained_fen: 210_750n,
    error_count: 0,
    held_count: 1,
    generation_started_at: ago(f, 36 * DAY),
    generated_at: ago(f, 36 * DAY - 10),
  });
  const settledBatches = [
    await seedBatch(f, settled, { status: 'DONE' }),
    await seedBatch(f, settled, { platform: 'jd', status: 'DONE' }),
  ];
  const empty = await seedBill(f, '2025-12', {
    platform_order_counts: {},
    platform_settle_commission_totals: {},
    beneficiary_total_fen: 0n,
    platform_retained_fen: 0n,
    error_count: 0,
    held_count: 0,
    generation_started_at: ago(f, 300 * DAY),
    generated_at: ago(f, 300 * DAY - 3),
  });
  // Another app: the same bill month and a newer one, with batches.
  const foreign = await seedBill(other, '2026-08');
  await seedBatch(other, foreign, { status: 'DONE' });
  await seedBill(other, '2026-10');
  const expected = [
    billView(generating, 'generating', []),
    billView(issued, 'issued', issuedBatches),
    billView(settled, 'settled', settledBatches),
    billView(empty, 'issued', []),
  ];
  const before = await footprint(f);
  const foreignBefore = await footprint(other);

  await withSettleAdmin(f, async (h) => {
    const root = await h.caller([], { superAdmin: true });
    for (const who of [h.biller, h.viewer, await h.caller([BILL, VIEW]), root]) {
      const data = await page(await h.list({}, who));
      expect({ page: data.page, page_size: data.page_size, total: data.total }).toEqual({
        page: 1,
        page_size: 20,
        total: 4,
      });
      for (const item of data.items) expect(Object.keys(item).sort()).toEqual([...BILL_KEYS]);
      expect(data.items.map(normalize)).toEqual(expected);
    }
  });
  expect(await allAudits(f)).toEqual([]);
  expect(await footprint(f)).toEqual(before);
  expect(await footprint(other)).toEqual(foreignBefore);
});

it('[AC-B2-09d#5] 账单列表的排序与分页：bill_id 倒序（跨年也按账单月，不按插入顺序或创建时刻）；page / page_size 翻页，total 为全部条数；超过最后一页是空 items（不报错）；page_size 200 可用', async () => {
  const f = fixture(s);
  // Inserted out of order, created_at unrelated to the month.
  const months = ['2026-02', '2025-11', '2026-12', '2026-01', '2025-12', '2026-11', '2026-10'];
  for (const [index, month] of months.entries()) {
    await seedBill(f, month, {
      generation_started_at: ago(f, (index + 1) * 60),
      generated_at: ago(f, (index + 1) * 60 - 5),
    });
  }
  const order = [...months].sort().reverse();
  await withSettleAdmin(f, async (h) => {
    expect(await billIds(await h.list())).toEqual(order);
    const walked: unknown[] = [];
    for (const n of [1, 2, 3]) {
      const data = await page(await h.list({ page: String(n), page_size: '3' }));
      expect({ page: data.page, page_size: data.page_size, total: data.total }).toEqual({
        page: n,
        page_size: 3,
        total: 7,
      });
      walked.push(...data.items.map((item) => item['bill_id']));
    }
    expect(walked).toEqual(order);
    expect(await page(await h.list({ page: '4', page_size: '3' }))).toEqual({
      items: [],
      page: 4,
      page_size: 3,
      total: 7,
    });
    const all = await page(await h.list({ page: '1', page_size: '200' }));
    expect({ page_size: all.page_size, total: all.total }).toEqual({ page_size: 200, total: 7 });
    expect(all.items.map((item) => item['bill_id'])).toEqual(order);
  });
});

it('[AC-B2-09d#6] 账单列表的筛选：bill_from、bill_to 两端都含、可只给一端；status 按响应时刻的派生状态筛（读注入的时钟：定时时刻一到，scheduled 的账单即转入 settling）；与区间按 AND 组合，total 为过滤后的总数；无匹配是空页', async () => {
  const f = fixture(s);
  const bill = (month: string) => seedBill(f, month);
  const b03 = await bill('2026-03');
  await seedBatch(f, b03, { status: 'DONE' });
  const b04 = await bill('2026-04');
  await seedBatch(f, b04);
  const b05 = await bill('2026-05');
  const due = later(f, 5);
  await seedBatch(f, b05, { status: 'CONFIRMED', settle_mode: 'SCHEDULED', scheduled_at: due });
  const b06 = await bill('2026-06');
  await seedBatch(f, b06, { status: 'EXECUTING' });
  await seedBill(f, '2026-07', GENERATING);
  await bill('2026-08');
  const b09 = await bill('2026-09');
  await seedBatch(f, b09, {
    status: 'CONFIRMED',
    settle_mode: 'SCHEDULED',
    scheduled_at: later(f, 60),
  });
  const before = await footprint(f);
  await withSettleAdmin(f, async (h) => {
    const listed = async (query: Record<string, string>, want: string[]) => {
      const data = await page(await h.list(query));
      expect(data.total, JSON.stringify(query)).toBe(want.length);
      const got = data.items.map((item) => item['bill_id']);
      expect(got, JSON.stringify(query)).toEqual(want);
    };
    const all = ['2026-09', '2026-08', '2026-07', '2026-06', '2026-05', '2026-04', '2026-03'];
    await listed({}, all);
    expect(await statuses(await h.list())).toEqual({
      '2026-09': 'scheduled',
      '2026-08': 'issued',
      '2026-07': 'generating',
      '2026-06': 'settling',
      '2026-05': 'scheduled',
      '2026-04': 'issued',
      '2026-03': 'settled',
    });
    await listed({ bill_from: '2026-05' }, ['2026-09', '2026-08', '2026-07', '2026-06', '2026-05']);
    await listed({ bill_to: '2026-05' }, ['2026-05', '2026-04', '2026-03']);
    await listed({ bill_from: '2026-04', bill_to: '2026-06' }, ['2026-06', '2026-05', '2026-04']);
    await listed({ bill_from: '2026-07', bill_to: '2026-07' }, ['2026-07']);
    await listed({ bill_from: '2026-10' }, []);
    await listed({ bill_to: '2025-12' }, []);
    await listed({ status: 'generating' }, ['2026-07']);
    await listed({ status: 'issued' }, ['2026-08', '2026-04']);
    await listed({ status: 'scheduled' }, ['2026-09', '2026-05']);
    await listed({ status: 'settling' }, ['2026-06']);
    await listed({ status: 'settled' }, ['2026-03']);
    await listed({ status: 'issued', bill_from: '2026-05' }, ['2026-08']);
    await listed({ status: 'settled', bill_from: '2026-04' }, []);
    const second = await page(await h.list({ status: 'scheduled', page: '2', page_size: '1' }));
    expect({ total: second.total, ids: second.items.map((item) => item['bill_id']) }).toEqual({
      total: 2,
      ids: ['2026-05'],
    });

    // The due instant reached: the bill of 2026-05 is settling now (not later than now).
    f.clock.set(due);
    await listed({ status: 'scheduled' }, ['2026-09']);
    await listed({ status: 'settling' }, ['2026-06', '2026-05']);
    f.clock.set(new Date(due.getTime() + 60_000));
    await listed({ status: 'settling', bill_to: '2026-05' }, ['2026-05']);
  });
  expect(await footprint(f)).toEqual(before);
});

it('[AC-B2-09d#7] 账单列表的拒绝：bill_from / bill_to 不是 YYYY-MM（13 月、00 月、斜杠、一位月份、带日）→ 20001 data.fields 指名该参数；status 不在 admin_settle_bill_status（批次状态 DONE、pending、未知值）→ 20001 [status]；bill_from 晚于 bill_to → 20001 data.fields=[bill_from, bill_to]；page_size 超过 200 → [page_size]；page 为 0 → [page]；边界值可用', async () => {
  const f = fixture(s);
  await seedBill(f, '2026-09');
  await withSettleAdmin(f, async (h) => {
    const refused = async (query: Record<string, string>, fields: string[]) => {
      await answer(await h.list(query), 20001, { fields });
    };
    await refused({ bill_from: '2026-13' }, ['bill_from']);
    await refused({ bill_from: '2026-00' }, ['bill_from']);
    await refused({ bill_from: '2026/09' }, ['bill_from']);
    await refused({ bill_to: '2026-9' }, ['bill_to']);
    await refused({ bill_to: '2026-09-01' }, ['bill_to']);
    await refused({ status: 'DONE' }, ['status']);
    await refused({ status: 'pending' }, ['status']);
    await refused({ status: 'unknown' }, ['status']);
    await refused({ bill_from: '2026-10', bill_to: '2026-09' }, ['bill_from', 'bill_to']);
    await refused({ bill_from: '2027-01', bill_to: '2026-12' }, ['bill_from', 'bill_to']);
    await refused({ page_size: '201' }, ['page_size']);
    await refused({ page: '0' }, ['page']);
    // The boundary values are accepted.
    const edge = await page(
      await h.list({ bill_from: '2026-09', bill_to: '2026-09', page_size: '200' }),
    );
    expect({ total: edge.total, ids: edge.items.map((item) => item['bill_id']) }).toEqual({
      total: 1,
      ids: ['2026-09'],
    });
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-09d#8] 账单列表的权限：没有 settle.bill 也没有 fund.view（无权限点，或只有 fund.recon、settle.statement_upload、withdraw.review 等别的点）→ 10403；不带令牌 → 10001；只有 settle.bill 且未做 step-up 也能读；空应用是空页；读取不写审计、不改账单', async () => {
  const f = fixture(s);
  const empty = fixture(s);
  const bill = await seedBill(f, '2026-09');
  const before = await footprint(f);
  await withSettleAdmin(f, async (h) => {
    await answer(await h.list({}, await h.caller([])), 10403);
    await answer(await h.list({}, await h.caller(['fund.recon'])), 10403);
    await answer(await h.list({}, await h.caller(['settle.statement_upload', 'pay.view'])), 10403);
    await answer(await h.list({}, await h.caller(['withdraw.review'])), 10403);
    await answer(await h.list({}, null), 10001);
    expect(await billIds(await h.list({}, h.biller))).toEqual([bill.bill_id]);
  });
  await withSettleAdmin(empty, async (h) => {
    expect(await page(await h.list({}, h.viewer))).toEqual({
      items: [],
      page: 1,
      page_size: 20,
      total: 0,
    });
  });
  expect(await allAudits(f)).toEqual([]);
  expect(await allAudits(empty)).toEqual([]);
  expect(await footprint(f)).toEqual(before);
});

/** Every batch of the app's bill, as stored now. */
function batchesOf(f: Fixture, billId: string): Promise<BatchRow[]> {
  return f.db
    .selectFrom('settle_batches')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('bill_id', '=', billId)
    .execute();
}

it('[AC-B2-09d#9] 账单日合计原样读出、不按明细重算（D10-280 ③）：platform_order_counts、platform_settle_commission_totals、beneficiary_total_fen（含 2^53−1）、platform_retained_fen、error_count、held_count 照 settle_bills 返回，与批次明细之和无关；随后发起的补充批次只改变派生状态与批次计数，合计仍是存储值', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09', {
    platform_order_counts: { taobao: 1200, jd: 300 },
    platform_settle_commission_totals: { taobao: 864_000, jd: 151_000 },
    beneficiary_total_fen: BIG,
    platform_retained_fen: 0n,
    error_count: 4,
    held_count: 0,
    generation_started_at: ago(f, 6 * DAY),
    generated_at: ago(f, 6 * DAY - 12),
  });
  // The batch items say something else entirely (one order of 999 fen).
  const main = await seedBatch(f, bill, { status: 'DONE', order_count: 1 });
  await seedOrderItem(f, main, { b_settle_fen: 999n, result: 'credited' });
  await withSettleAdmin(f, async (h) => {
    const row = async () => {
      const data = await page(await h.list());
      expect(data.items, JSON.stringify(data)).toHaveLength(1);
      return normalize(data.items[0]);
    };
    expect(await row()).toEqual(billView(bill, 'settled', [main]));
    const amounts = (await row()) as Record<string, unknown>;
    expect(amounts['beneficiary_total_fen']).toBe(Number(BIG));
    expect(Number.isSafeInteger(amounts['beneficiary_total_fen'])).toBe(true);

    // A supplement launch two days later, executed: still settled, one batch more, same totals.
    const done = await seedBatch(f, bill, {
      kind: 'supplement',
      status: 'DONE',
      order_count: 2,
      created_at: ago(f, 2 * DAY),
    });
    await seedOrderItem(f, done, { b_settle_fen: 5_000n, result: 'credited' });
    await seedOrderItem(f, done, { b_settle_fen: 7_000n, result: 'credited' });
    expect(await row()).toEqual(billView(bill, 'settled', await batchesOf(f, bill.bill_id)));
    // Another launch, waiting for confirmation: issued, one DRAFT batch, same totals.
    await seedBatch(f, bill, { kind: 'supplement', platform: 'jd', created_at: ago(f, DAY) });
    const now = await batchesOf(f, bill.bill_id);
    expect(now).toHaveLength(3);
    expect(await row()).toEqual(billView(bill, 'issued', now));
    expect(((await row()) as Record<string, unknown>)['draft_batch_count']).toBe(1);
  });
  const stored = await f.db
    .selectFrom('settle_bills')
    .selectAll()
    .where('app_id', '=', f.appId)
    .execute();
  expect(stored).toEqual([bill]);
});
