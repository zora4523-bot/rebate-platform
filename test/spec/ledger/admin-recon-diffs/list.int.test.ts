// B2-09a list rule tests (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// listAdminReconDiffs (GET /admin/v1/recon-diffs: fund.recon or fund.view, read only, no step-up;
// only the app's recon_diffs of source R1–R3, R4 stays in /admin/v1/pay-recon-diffs; filters type /
// source / status / ref_id (exact) / period_from / period_to (inclusive, compared as strings, so a
// YYYY-MM period sorts before the days of its month) combine with AND; a value outside an enum or
// pattern → 20001 data.fields naming it; period_from > period_to → 20001
// data.fields=[period_from, period_to]; created_at then recon_diff_id descending; a page past the
// last → items=[]; page_size ≤ 200; total = count of the filter set; reading writes no audit
// record); 08 BR-FUND-22 (差错单「已作废订单被平台恢复」/「申诉恢复」: types platform_restore /
// appeal_restore). Requests go through the real admin entry (kit.ts). Top-level it() only
// (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  LIST_KEYS,
  RECON,
  VIEW,
  ago,
  allAudits,
  allDiffs,
  answer,
  fixture,
  ids,
  listView,
  newestFirst,
  normalize,
  page,
  seedDiff,
  suite,
  withReconAdmin,
  type DiffRow,
} from './kit.ts';

const s = suite();

it('[AC-B2-09a#1] 差错单列表（fund.recon 或 fund.view 任一即可，不要 step-up）：只列本应用 source R1–R3 的差错单，按 created_at 倒序，每行恰好是契约的 AdminReconDiff（来源、类型、期间、引用、三个金额、状态、创建与结案时刻）；R4 的收款差错与其他应用的差错单不出现；默认 page 1 / page_size 20；两点都有、超管也能读；读取不写审计', async () => {
  const f = fixture(s);
  const other = fixture(s);
  await withReconAdmin(f, async (h) => {
    const union = await seedDiff(f, {
      type: 'union_mismatch',
      source: 'R1',
      period: '2026-09',
      ref_type: 'order',
      ref_id: 'taobao:5550001',
      expected_fen: 1_234n,
      actual_fen: 1_200n,
      diff_fen: 34n,
      status: 'closed',
      handler_id: h.recon.id,
      closed_at: ago(f, 10),
      resolution: { reason: '联盟结算明细已核对，差额由联盟侧调整' },
      created_at: ago(f, 60),
      updated_at: ago(f, 10),
    });
    const channel = await seedDiff(f, {
      type: 'channel_mismatch',
      source: 'R2',
      period: '2026-10-27',
      ref_type: 'withdrawal',
      expected_fen: 5_000n,
      actual_fen: 0n,
      diff_fen: 5_000n,
      status: 'processing',
      handler_id: h.viewer.id,
      created_at: ago(f, 50),
      updated_at: ago(f, 20),
    });
    const ledger = await seedDiff(f, {
      type: 'ledger_mismatch',
      source: 'R3',
      period: '2026-10-28',
      ref_type: 'account',
      expected_fen: 12_000n,
      actual_fen: 11_800n,
      diff_fen: 200n,
      created_at: ago(f, 40),
    });
    const restore = await seedDiff(f, {
      type: 'platform_restore',
      source: 'R1',
      period: '2026-10-06',
      ref_type: 'order',
      ref_id: 'taobao:5550002',
      expected_fen: 1_234n,
      actual_fen: 0n,
      diff_fen: 1_234n,
      created_at: ago(f, 30),
    });
    const appeal = await seedDiff(f, {
      type: 'appeal_restore',
      source: 'R3',
      period: '2026-10-06',
      ref_type: 'order',
      ref_id: 'taobao:5550001',
      expected_fen: 123n,
      actual_fen: 0n,
      diff_fen: 123n,
      created_at: ago(f, 25),
    });
    // Collection differences (source R4) and another app's differences, all newer.
    await seedDiff(f, {
      type: 'pay_mismatch',
      source: 'R4',
      ref_type: 'pay_order',
      dedupe_key: `spec:${randomUUID()}`,
      created_at: ago(f, 5),
    });
    await seedDiff(f, {
      type: 'pay_anomaly',
      source: 'R4',
      ref_type: 'pay_anomaly',
      created_at: ago(f, 4),
    });
    await seedDiff(other, { type: 'union_mismatch', source: 'R1', created_at: ago(f, 3) });
    await seedDiff(other, { type: 'ledger_mismatch', source: 'R3', created_at: ago(f, 2) });
    const expected = [appeal, restore, ledger, channel, union].map(listView);

    for (const who of [h.recon, h.viewer, await h.caller([RECON, VIEW])]) {
      const data = await page(await h.list({}, who));
      expect({ page: data.page, page_size: data.page_size, total: data.total }).toEqual({
        page: 1,
        page_size: 20,
        total: 5,
      });
      for (const item of data.items) expect(Object.keys(item).sort()).toEqual([...LIST_KEYS]);
      expect(data.items.map(normalize)).toEqual(expected);
    }
    const root = await h.caller([], { superAdmin: true });
    expect((await page(await h.list({}, root))).items.map(normalize)).toEqual(expected);
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-09a#2] 差错单列表的排序与分页：created_at 倒序，同一时刻按 recon_diff_id 倒序；page / page_size 翻页，total 为全部条数；超过最后一页是空 items（不报错）', async () => {
  const f = fixture(s);
  const rows: DiffRow[] = [];
  for (const minutes of [70, 10, 50, 30, 30, 30, 90]) {
    rows.push(
      await seedDiff(f, {
        created_at: ago(f, minutes),
        updated_at: ago(f, minutes),
      }),
    );
  }
  const order = newestFirst(rows).map((row) => row.id);
  await withReconAdmin(f, async (h) => {
    expect(await ids(await h.list())).toEqual(order);
    const walked: unknown[] = [];
    for (const n of [1, 2, 3]) {
      const data = await page(await h.list({ page: String(n), page_size: '3' }));
      expect({ page: data.page, page_size: data.page_size, total: data.total }).toEqual({
        page: n,
        page_size: 3,
        total: 7,
      });
      walked.push(...data.items.map((item) => item['recon_diff_id']));
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
    expect(all.items.map((item) => item['recon_diff_id'])).toEqual(order);
  });
});

it('[AC-B2-09a#3] 差错单列表的筛选：type、source、status、ref_id（精确匹配，不是前缀、不忽略大小写）按 AND 组合，total 为过滤后的总数；同 ref_id 的 R4 差错不出现', async () => {
  const f = fixture(s);
  const ref = 'taobao:5550001';
  const seed = (type: string, source: string, status: string, ref_id: string, at: number) =>
    seedDiff(f, {
      type,
      source,
      status,
      ref_type: 'order',
      ref_id,
      closed_at: status === 'closed' ? ago(f, 1) : null,
      created_at: ago(f, at),
      updated_at: ago(f, at),
    });
  // u1 union, r1 / r2 platform restore, c1 channel, l1 ledger, a1 / a2 appeal restore.
  const u1 = await seed('union_mismatch', 'R1', 'open', ref, 90);
  const r1 = await seed('platform_restore', 'R1', 'open', ref, 80);
  const r2 = await seed('platform_restore', 'R1', 'closed', 'taobao:55500010', 70);
  const c1 = await seed('channel_mismatch', 'R2', 'processing', randomUUID(), 60);
  const l1 = await seed('ledger_mismatch', 'R3', 'open', randomUUID(), 50);
  const a1 = await seed('appeal_restore', 'R3', 'adjusted', ref, 40);
  const a2 = await seed('appeal_restore', 'R3', 'written_off', 'TAOBAO:5550001', 30);
  await seedDiff(f, {
    type: 'pay_mismatch',
    source: 'R4',
    ref_type: 'pay_order',
    ref_id: ref,
    created_at: ago(f, 5),
  });
  await withReconAdmin(f, async (h) => {
    const listed = async (query: Record<string, string>, want: DiffRow[]) => {
      const data = await page(await h.list(query));
      expect(data.total, JSON.stringify(query)).toBe(want.length);
      const got = data.items.map((item) => item['recon_diff_id']);
      expect(got, JSON.stringify(query)).toEqual(want.map((row) => row.id));
    };
    await listed({}, [a2, a1, l1, c1, r2, r1, u1]);
    await listed({ type: 'platform_restore' }, [r2, r1]);
    await listed({ type: 'appeal_restore' }, [a2, a1]);
    await listed({ type: 'settle_missing' }, []);
    await listed({ source: 'R1' }, [r2, r1, u1]);
    await listed({ source: 'R2' }, [c1]);
    await listed({ source: 'R3' }, [a2, a1, l1]);
    await listed({ status: 'open' }, [l1, r1, u1]);
    await listed({ status: 'written_off' }, [a2]);
    await listed({ ref_id: ref }, [a1, r1, u1]);
    await listed({ ref_id: 'taobao:555000' }, []);
    await listed({ source: 'R1', status: 'open' }, [r1, u1]);
    await listed({ source: 'R1', ref_id: ref, type: 'platform_restore' }, [r1]);
    await listed({ source: 'R2', type: 'union_mismatch' }, []);
    const second = await page(await h.list({ ref_id: ref, page: '2', page_size: '2' }));
    expect(second.total).toBe(3);
    expect(second.items.map((item) => item['recon_diff_id'])).toEqual([u1.id]);
  });
});

it('[AC-B2-09a#4] 差错单列表的期间区间：period_from、period_to 两端都含，按字符串比较（YYYY-MM 排在该月各日之前）；可只给一端，可与 source 组合', async () => {
  const f = fixture(s);
  const periods = [
    '2026-09',
    '2026-09-01',
    '2026-09-30',
    '2026-10',
    '2026-10-01',
    '2026-10-15',
    '2026-11',
  ];
  const byPeriod = new Map<string, DiffRow>();
  for (const [index, period] of periods.entries()) {
    const row = await seedDiff(f, {
      type: index % 2 === 0 ? 'union_mismatch' : 'ledger_mismatch',
      source: index % 2 === 0 ? 'R1' : 'R3',
      period,
      created_at: ago(f, 100 - index),
      updated_at: ago(f, 100 - index),
    });
    byPeriod.set(period, row);
  }
  const of = (...list: string[]) =>
    newestFirst(list.map((period) => byPeriod.get(period)!)).map((row) => row.id);
  await withReconAdmin(f, async (h) => {
    const check = async (query: Record<string, string>, want: string[]) => {
      const data = await page(await h.list(query));
      expect(data.total, JSON.stringify(query)).toBe(want.length);
      const got = data.items.map((item) => item['recon_diff_id']);
      expect(got, JSON.stringify(query)).toEqual(want);
    };
    await check(
      { period_from: '2026-09-30', period_to: '2026-10-15' },
      of('2026-09-30', '2026-10', '2026-10-01', '2026-10-15'),
    );
    await check({ period_from: '2026-10' }, of('2026-10', '2026-10-01', '2026-10-15', '2026-11'));
    await check({ period_to: '2026-10' }, of('2026-09', '2026-09-01', '2026-09-30', '2026-10'));
    await check({ period_from: '2026-09-01', period_to: '2026-09-01' }, of('2026-09-01'));
    await check(
      { period_from: '2026-09', period_to: '2026-09-30' },
      of('2026-09', '2026-09-01', '2026-09-30'),
    );
    await check({ period_from: '2026-12' }, []);
    await check(
      { period_from: '2026-09-30', period_to: '2026-10-15', source: 'R1' },
      of('2026-09-30', '2026-10-01'),
    );
  });
});

it('[AC-B2-09a#5] 差错单列表的金额是整数分原样（不换算、不改符号）：负数、零与 2^53−1 照存储返回', async () => {
  const f = fixture(s);
  const big = 9_007_199_254_740_991n;
  const negative = await seedDiff(f, {
    expected_fen: 0n,
    actual_fen: 1_234n,
    diff_fen: -1_234n,
    created_at: ago(f, 3),
  });
  const large = await seedDiff(f, {
    expected_fen: big,
    actual_fen: 0n,
    diff_fen: big,
    created_at: ago(f, 2),
  });
  const minus = await seedDiff(f, {
    expected_fen: -1n,
    actual_fen: -1n,
    diff_fen: 0n,
    created_at: ago(f, 1),
  });
  await withReconAdmin(f, async (h) => {
    const data = await page(await h.list());
    const amounts = data.items.map((item) => [
      item['expected_fen'],
      item['actual_fen'],
      item['diff_fen'],
    ]);
    expect(amounts).toEqual([
      [-1, -1, 0],
      [Number(big), 0, Number(big)],
      [0, 1_234, -1_234],
    ]);
    expect(amounts.flat().every((value) => Number.isSafeInteger(value))).toBe(true);
    expect(data.items.map(normalize)).toEqual([minus, large, negative].map(listView));
  });
});

it('[AC-B2-09a#6] 差错单列表的拒绝：type 不是 R1–R3 类型（pay_mismatch 或未知值）、source 是 R4 或未知、status 不在枚举、period_from / period_to 不是 YYYY-MM[-DD]、ref_id 超过 128 字符 → 20001 data.fields 指名该参数；period_from > period_to（含 2026-10-01 对 2026-10）→ 20001 data.fields=[period_from, period_to]；page_size 超过 200 → 20001 [page_size]', async () => {
  const f = fixture(s);
  await seedDiff(f);
  const RANGE = ['period_from', 'period_to'];
  await withReconAdmin(f, async (h) => {
    const refused = async (query: Record<string, string>, fields: string[]) => {
      await answer(await h.list(query), 20001, { fields });
    };
    await refused({ type: 'pay_mismatch' }, ['type']);
    await refused({ type: 'pay_anomaly' }, ['type']);
    await refused({ type: 'unknown_type' }, ['type']);
    await refused({ source: 'R4' }, ['source']);
    await refused({ source: 'R5' }, ['source']);
    await refused({ status: 'resolved' }, ['status']);
    await refused({ period_from: '2026-13' }, ['period_from']);
    await refused({ period_from: '2026/10' }, ['period_from']);
    await refused({ period_to: '2026-10-32' }, ['period_to']);
    await refused({ period_to: '2026-1' }, ['period_to']);
    await refused({ ref_id: 'x'.repeat(129) }, ['ref_id']);
    await refused({ period_from: '2026-10-02', period_to: '2026-10-01' }, RANGE);
    await refused({ period_from: '2026-10-01', period_to: '2026-10' }, RANGE);
    await refused({ period_from: '2026-11', period_to: '2026-10-31' }, RANGE);
    await refused({ page_size: '201' }, ['page_size']);
    // The boundary values are accepted.
    const edge = await page(await h.list({ ref_id: 'x'.repeat(128), page_size: '200' }));
    expect(edge.total).toBe(0);
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-09a#7] 差错单列表的权限：没有 fund.recon 也没有 fund.view（无权限点，或只有 pay.view、fund.settle_adjust 等别的点）→ 10403；不带令牌 → 10001；空应用是空页；读取不写审计、不改差错单', async () => {
  const f = fixture(s);
  const empty = fixture(s);
  const row = await seedDiff(f, { type: 'union_mismatch', source: 'R1' });
  await withReconAdmin(f, async (h) => {
    await answer(await h.list({}, await h.caller([])), 10403);
    await answer(await h.list({}, await h.caller(['pay.view'])), 10403);
    await answer(await h.list({}, await h.caller(['fund.settle_adjust', 'pay.resolve'])), 10403);
    await answer(await h.list({}, null), 10001);
    expect(await ids(await h.list())).toEqual([row.id]);
  });
  await withReconAdmin(empty, async (h) => {
    expect(await page(await h.list({}, h.viewer))).toEqual({
      items: [],
      page: 1,
      page_size: 20,
      total: 0,
    });
  });
  expect(await allAudits(f)).toEqual([]);
  expect(await allAudits(empty)).toEqual([]);
  expect(await allDiffs(f)).toEqual([row]);
});
