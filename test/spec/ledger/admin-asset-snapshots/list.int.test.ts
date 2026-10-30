// B2-09e list rule tests (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// listAdminAssetSnapshots (GET /admin/v1/asset-snapshots, CT-24zb: fund.view, read only, no
// step-up, a super admin holds every point; only the asset_snapshots of the caller's app, each row
// the snapshot of accounting day D with its five totals, waiting_comparable, the
// asset_snapshot_receivables rows ordered by platform code and created_at / updated_at; amounts
// integer fen exactly as written, never recomputed; a day whose snapshot is not written has no
// row, reading never triggers or rewrites one; date_from / date_to YYYY-MM-DD inclusive, a value
// not a date → 20001 data.fields naming it, date_from > date_to → 20001
// data.fields=[date_from, date_to]; snapshot_date descending; a page past the last → items=[];
// page_size ≤ 200; total = count of the filter set; reading writes no audit record); 08
// BR-FUND-18 (asset_snapshots written at D+1 00:01:00 +08:00; waiting_comparable=false when the
// snapshot timed out). Requests go through the real admin entry (kit.ts). Top-level it() only
// (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  ITEM_KEYS,
  VIEW,
  allAudits,
  allReceivables,
  allSnapshots,
  answer,
  days,
  fixture,
  latestFirst,
  normalize,
  page,
  seedSnapshot,
  snapshotEvents,
  suite,
  view,
  withSnapshotAdmin,
  writtenAt,
  type Seeded,
} from './kit.ts';

const s = suite();

/** 2^53 − 1: the largest fen the JSON integer of the contract carries exactly. */
const BIG = 9_007_199_254_740_991n;

it('[AC-B2-09e#2] 资产快照列表（fund.view，不要 step-up）：只列本应用的 asset_snapshots，按 snapshot_date 倒序，每行恰好是契约的 AdminAssetSnapshot（快照日、五项合计、waiting_comparable、各平台应收、写入与更新时刻）；其他应用同一天与更晚的快照不出现；默认 page 1 / page_size 20；带其他权限点或超管也能读；读取不写审计、不改两张表', async () => {
  const f = fixture(s);
  const other = fixture(s);
  const d27 = await seedSnapshot(f, {
    day: '2026-10-27',
    total_available_positive_fen: 1_198_000n,
    total_negative_fen: 3_200n,
    total_frozen_fen: 52_000n,
    total_waiting_fen: 845_000n,
    total_estimated_fen: 2_287_000n,
    receivables: { taobao: 850_500n },
  });
  const d28 = await seedSnapshot(f, {
    day: '2026-10-28',
    waitingComparable: false,
    total_available_positive_fen: 1_210_000n,
    total_negative_fen: 0n,
    total_frozen_fen: 50_000n,
    total_waiting_fen: 851_000n,
    total_estimated_fen: 2_300_000n,
    receivables: { taobao: 855_000n, jd: 140_000n },
    createdAt: writtenAt('2026-10-28', 30 * 60_000 + 10_000),
  });
  const d29 = await seedSnapshot(f, {
    day: '2026-10-29',
    total_available_positive_fen: 1_250_000n,
    total_negative_fen: 3_200n,
    total_frozen_fen: 48_000n,
    total_waiting_fen: 860_000n,
    total_estimated_fen: 2_310_000n,
    receivables: { taobao: 864_000n, jd: 151_000n },
    createdAt: writtenAt('2026-10-29', 2_000),
    updatedAt: writtenAt('2026-10-29', 3_000),
  });
  // Another app's snapshots: the same days with other amounts, and a later day.
  for (const day of ['2026-10-28', '2026-10-29', '2026-10-30']) {
    await seedSnapshot(other, {
      day,
      total_available_positive_fen: 7n,
      total_waiting_fen: 7n,
      receivables: { pdd: 7n },
    });
  }
  const snapshotsBefore = await allSnapshots(f);
  const receivablesBefore = await allReceivables(f);
  const otherBefore = await allSnapshots(other);
  const expected = [d29, d28, d27].map(view);

  await withSnapshotAdmin(f, async (h) => {
    const callers = [
      h.viewer,
      await h.caller([VIEW, 'fund.recon', 'fund.cash_entry']),
      await h.caller([], { superAdmin: true }),
    ];
    for (const who of callers) {
      const data = await page(await h.list({}, who));
      expect({ page: data.page, page_size: data.page_size, total: data.total }).toEqual({
        page: 1,
        page_size: 20,
        total: 3,
      });
      for (const item of data.items) expect(Object.keys(item).sort()).toEqual([...ITEM_KEYS]);
      expect(data.items.map(normalize)).toEqual(expected);
    }
  });
  expect(await allAudits(f)).toEqual([]);
  expect(await allSnapshots(f)).toEqual(snapshotsBefore);
  expect(await allReceivables(f)).toEqual(receivablesBefore);
  expect(await allSnapshots(other)).toEqual(otherBefore);
});

it('[AC-B2-09e#3] 资产快照列表的排序与分页：snapshot_date 倒序（与写入先后无关）；page / page_size 翻页，total 为全部条数；超过最后一页是空 items（不报错）；page_size 200 一页取完', async () => {
  const f = fixture(s);
  const rows: Seeded[] = [];
  // Written out of day order (a late or repeated run), across a month boundary.
  for (const day of [
    '2026-10-02',
    '2026-09-29',
    '2026-10-05',
    '2026-09-30',
    '2026-10-01',
    '2026-10-04',
    '2026-10-03',
  ]) {
    rows.push(await seedSnapshot(f, { day }));
  }
  const order = latestFirst(rows).map((row) => row.day);
  expect(order).toEqual([
    '2026-10-05',
    '2026-10-04',
    '2026-10-03',
    '2026-10-02',
    '2026-10-01',
    '2026-09-30',
    '2026-09-29',
  ]);
  await withSnapshotAdmin(f, async (h) => {
    expect(await days(await h.list())).toEqual(order);
    const walked: unknown[] = [];
    for (const n of [1, 2, 3]) {
      const data = await page(await h.list({ page: String(n), page_size: '3' }));
      expect({ page: data.page, page_size: data.page_size, total: data.total }).toEqual({
        page: n,
        page_size: 3,
        total: 7,
      });
      walked.push(...data.items.map((item) => item['snapshot_date']));
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
    expect(all.items.map(normalize)).toEqual(latestFirst(rows).map(view));
  });
});

it('[AC-B2-09e#4] 资产快照列表的快照日区间：date_from、date_to 两端都含，可只给一端，可相等；没有命中是空页（total 0）；区间内没写入快照的日子没有行（不补零）；与分页组合时 total 为区间内条数', async () => {
  const f = fixture(s);
  // 2026-10-03 and 2026-10-06 have no snapshot written.
  const written = [
    '2026-09-30',
    '2026-10-01',
    '2026-10-02',
    '2026-10-04',
    '2026-10-05',
    '2026-10-07',
  ];
  for (const day of written) await seedSnapshot(f, { day });
  await withSnapshotAdmin(f, async (h) => {
    const check = async (query: Record<string, string>, want: string[]) => {
      const data = await page(await h.list(query));
      expect(data.total, JSON.stringify(query)).toBe(want.length);
      const got = data.items.map((item) => item['snapshot_date']);
      expect(got, JSON.stringify(query)).toEqual(want);
    };
    await check({ date_from: '2026-10-01', date_to: '2026-10-05' }, [
      '2026-10-05',
      '2026-10-04',
      '2026-10-02',
      '2026-10-01',
    ]);
    await check({ date_from: '2026-10-04' }, ['2026-10-07', '2026-10-05', '2026-10-04']);
    await check({ date_to: '2026-10-01' }, ['2026-10-01', '2026-09-30']);
    await check({ date_from: '2026-10-02', date_to: '2026-10-02' }, ['2026-10-02']);
    await check({ date_from: '2026-10-03', date_to: '2026-10-03' }, []);
    await check({ date_from: '2026-10-06', date_to: '2026-10-06' }, []);
    await check({ date_from: '2026-10-08' }, []);
    await check({ date_to: '2026-09-29' }, []);
    await check({ date_from: '2026-09-01', date_to: '2026-09-30' }, ['2026-09-30']);
    const second = await page(
      await h.list({ date_from: '2026-10-01', date_to: '2026-10-07', page: '2', page_size: '2' }),
    );
    expect({ page: second.page, page_size: second.page_size, total: second.total }).toEqual({
      page: 2,
      page_size: 2,
      total: 5,
    });
    expect(second.items.map((item) => item['snapshot_date'])).toEqual(['2026-10-04', '2026-10-02']);
  });
  expect((await allSnapshots(f)).map((row) => row.day)).toEqual(written);
});

it('[AC-B2-09e#5] 资产快照列表的金额是快照写入时的整数分原样（不按当前余额或订单重算、不改符号）：五项合计含 0 与 2^53−1；waiting_comparable 的 true / false 照存；各平台应收按平台代码排序、含负数与大整数，没有应收行时是空数组；updated_at 与 created_at 各自照存', async () => {
  const f = fixture(s);
  // The app has no ledger account, balance, order or share at all: every amount below can only
  // come from the snapshot rows themselves.
  const big = await seedSnapshot(f, {
    day: '2026-10-20',
    total_available_positive_fen: BIG,
    total_negative_fen: BIG,
    total_frozen_fen: BIG,
    total_waiting_fen: BIG,
    total_estimated_fen: BIG,
    waitingComparable: true,
    receivables: { taobao: BIG, douyin: -1n, jd: 0n, pdd: 123_456_789_012n },
  });
  const zero = await seedSnapshot(f, {
    day: '2026-10-21',
    total_available_positive_fen: 0n,
    total_negative_fen: 0n,
    total_frozen_fen: 0n,
    total_waiting_fen: 0n,
    total_estimated_fen: 0n,
    waitingComparable: false,
    receivables: {},
  });
  // A timed-out snapshot confirmed late: updated_at after created_at, still not comparable.
  const late = await seedSnapshot(f, {
    day: '2026-10-22',
    total_available_positive_fen: 1_234n,
    total_negative_fen: 400n,
    total_frozen_fen: 1n,
    total_waiting_fen: 925n,
    total_estimated_fen: 1_048n,
    waitingComparable: false,
    receivables: { suning: 5n, eleme: -500n, vip: 2n, kuaishou: 3n, meituan: 4n },
    createdAt: writtenAt('2026-10-22', 31 * 60_000),
    updatedAt: writtenAt('2026-10-22', 45 * 60_000 + 123),
  });
  await withSnapshotAdmin(f, async (h) => {
    const data = await page(await h.list());
    expect(data.items.map(normalize)).toEqual([late, zero, big].map(view));
    const amounts = data.items.flatMap((item) => [
      item['total_available_positive_fen'],
      item['total_negative_fen'],
      item['total_frozen_fen'],
      item['total_waiting_fen'],
      item['total_estimated_fen'],
      ...(item['receivables'] as Record<string, unknown>[]).map(
        (receivable) => receivable['union_receivable_fen'],
      ),
    ]);
    expect(amounts.every((value) => Number.isSafeInteger(value))).toBe(true);
    const first = data.items[2]!;
    expect(first['total_available_positive_fen']).toBe(Number(BIG));
    expect(first['receivables']).toEqual([
      { platform: 'douyin', union_receivable_fen: -1 },
      { platform: 'jd', union_receivable_fen: 0 },
      { platform: 'pdd', union_receivable_fen: 123_456_789_012 },
      { platform: 'taobao', union_receivable_fen: Number(BIG) },
    ]);
    expect(data.items[1]!['receivables']).toEqual([]);
    expect(data.items[1]!['waiting_comparable']).toBe(false);
    expect(data.items[0]!['receivables']).toEqual([
      { platform: 'eleme', union_receivable_fen: -500 },
      { platform: 'kuaishou', union_receivable_fen: 3 },
      { platform: 'meituan', union_receivable_fen: 4 },
      { platform: 'suning', union_receivable_fen: 5 },
      { platform: 'vip', union_receivable_fen: 2 },
    ]);
    expect(data.items[0]!['snapshot_date']).toBe('2026-10-22');
  });
});

it('[AC-B2-09e#6] 资产快照列表的拒绝：date_from / date_to 不是 YYYY-MM-DD 日期（月份 13、32 日、2 月 30 日、斜杠、缺位、只有年月、带时刻）→ 20001 data.fields 指名该参数；date_from 晚于 date_to → 20001 data.fields=[date_from, date_to]；page_size 超过 200 → 20001 [page_size]；拒绝不写审计、不写快照', async () => {
  const f = fixture(s);
  await seedSnapshot(f, { day: '2026-10-01' });
  const before = await allSnapshots(f);
  const RANGE = ['date_from', 'date_to'];
  await withSnapshotAdmin(f, async (h) => {
    // The boundary values are accepted.
    const edge = await page(
      await h.list({ date_from: '2026-10-01', date_to: '2026-10-01', page_size: '200' }),
    );
    expect({ page_size: edge.page_size, total: edge.total }).toEqual({ page_size: 200, total: 1 });
    const refused = async (query: Record<string, string>, fields: string[]) => {
      await answer(await h.list(query), 20001, { fields });
    };
    await refused({ date_from: '2026-13-01' }, ['date_from']);
    await refused({ date_from: '2026-10-32' }, ['date_from']);
    await refused({ date_from: '2026-02-30' }, ['date_from']);
    await refused({ date_from: '2026/10/01' }, ['date_from']);
    await refused({ date_from: '2026-10' }, ['date_from']);
    await refused({ date_to: '2026-10-1' }, ['date_to']);
    await refused({ date_to: '20261001' }, ['date_to']);
    await refused({ date_to: '2026-10-01T00:00:00+08:00' }, ['date_to']);
    await refused({ date_to: 'yesterday' }, ['date_to']);
    await refused({ date_from: '2026-10-02', date_to: '2026-10-01' }, RANGE);
    await refused({ date_from: '2026-11-01', date_to: '2026-10-31' }, RANGE);
    await refused({ date_from: '2027-01-01', date_to: '2026-12-31' }, RANGE);
    await refused({ page_size: '201' }, ['page_size']);
  });
  expect(await allAudits(f)).toEqual([]);
  expect(await allSnapshots(f)).toEqual(before);
});

it('[AC-B2-09e#7] 资产快照列表的权限：只认 fund.view（超管除外）——没有权限点、只有 fund.recon、或只有 fund.cash_entry / pay.view / fund.settle_adjust 等别的点 → 10403；不带令牌 → 10001；空应用是空页；读取不写审计、不改快照', async () => {
  const f = fixture(s);
  const empty = fixture(s);
  const row = await seedSnapshot(f, { day: '2026-10-29', receivables: { jd: 151_000n } });
  const before = await allSnapshots(f);
  const receivablesBefore = await allReceivables(f);
  await withSnapshotAdmin(f, async (h) => {
    expect((await page(await h.list())).items.map(normalize)).toEqual([view(row)]);
    await answer(await h.list({}, await h.caller([])), 10403);
    await answer(await h.list({}, await h.caller(['fund.recon'])), 10403);
    await answer(
      await h.list({}, await h.caller(['fund.cash_entry', 'pay.view', 'fund.settle_adjust'])),
      10403,
    );
    await answer(await h.list({}, null), 10001);
  });
  await withSnapshotAdmin(empty, async (h) => {
    expect(await page(await h.list())).toEqual({
      items: [],
      page: 1,
      page_size: 20,
      total: 0,
    });
  });
  expect(await allAudits(f)).toEqual([]);
  expect(await allAudits(empty)).toEqual([]);
  expect(await allSnapshots(f)).toEqual(before);
  expect(await allReceivables(f)).toEqual(receivablesBefore);
  expect(await allSnapshots(empty)).toEqual([]);
});

it('[AC-B2-09e#8] 未写入的快照日没有行，读取不触发补写：当前 2026-10-30 10:00 +08:00，10-28 的快照没写、10-30 的还没到 → 列表与区间筛选都不出现这两天、不补零；读后 asset_snapshots / asset_snapshot_receivables 不新增不改（超时未确认的 waiting_comparable=false 仍是 false），没有快照或告警事件', async () => {
  const f = fixture(s);
  const d26 = await seedSnapshot(f, { day: '2026-10-26' });
  const d27 = await seedSnapshot(f, {
    day: '2026-10-27',
    waitingComparable: false,
    createdAt: writtenAt('2026-10-27', 31 * 60_000),
    receivables: { taobao: 1n, jd: 2n },
  });
  const d29 = await seedSnapshot(f, { day: '2026-10-29', receivables: {} });
  const before = await allSnapshots(f);
  const receivablesBefore = await allReceivables(f);
  await withSnapshotAdmin(f, async (h) => {
    const all = await page(await h.list());
    expect(all.total).toBe(3);
    expect(all.items.map(normalize)).toEqual([d29, d27, d26].map(view));
    expect(await days(await h.list({ date_from: '2026-10-28', date_to: '2026-10-30' }))).toEqual([
      '2026-10-29',
    ]);
    expect(await page(await h.list({ date_from: '2026-10-28', date_to: '2026-10-28' }))).toEqual({
      items: [],
      page: 1,
      page_size: 20,
      total: 0,
    });
    expect(await days(await h.list({ date_from: '2026-10-30' }))).toEqual([]);
    // Reading again answers the same: nothing was filled in by the first reads.
    expect((await page(await h.list())).items.map(normalize)).toEqual([d29, d27, d26].map(view));
  });
  expect(await allSnapshots(f)).toEqual(before);
  expect(await allReceivables(f)).toEqual(receivablesBefore);
  expect(await snapshotEvents(f)).toEqual([]);
  expect(await allAudits(f)).toEqual([]);
});
