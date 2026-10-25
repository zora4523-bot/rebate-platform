// B2-15j admin list rule tests (claude-independent, SPEC_REF 736d24c5): contracts/openapi.yaml
// listAdminPayReconDiffs（pay.view，只读、不要 step-up；只列 source R4、type pay_mismatch / pay_anomaly 的
// 收款差错，R1–R3 不在这里；type / status 按 AND 过滤，取值不在枚举 → 20001 data.fields 指名该参数；
// created_at 倒序；page_size ≤ 200；读取不写审计）；08 BR-PAY-07（收款差错单的处置：补做查询后按
// BR-PAY-04 / 05 正常结束、登记异常收款并退款、人工关闭 —— 契约里没有处置接口，这里只断言差错单创建时的
// 状态与结束所需的引用 ref_type / ref_id）。Requests go through the real admin entry (kit.ts).
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { fixture, suite } from '../orders/kit.ts';
import { anomalies } from '../result/kit.ts';
import {
  BILL_DATE,
  DIFF_KEYS,
  allAudits,
  answer,
  closedOrder,
  diffOf,
  diffView,
  lineOf,
  page,
  pendingOrder,
  recon,
  seedDiff,
  withReconAdmin,
  type DiffRow,
} from './kit.ts';

const s = suite();
const MINUTE = 60_000;

it('[AC-B2-15j#22] 对账差错列表（pay.view，不要 step-up）：只列本应用 source R4 的 pay_mismatch / pay_anomaly，按 created_at 倒序，每行就是契约的 AdminPayReconDiff（期间、引用、三个金额、状态、创建与关闭时刻）；R1–R3 的差错与其他应用的差错不出现；分页默认 1 / 20；超管也能读；读取不写审计', async () => {
  const r = await recon(s);
  const f = r.f;
  const now = f.clock.now().getTime();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * MINUTE);
  const a = await seedDiff(f, {
    type: 'pay_mismatch',
    ref_type: 'pay_order',
    expected_fen: 12_345n,
    actual_fen: 12_300n,
    diff_fen: 45n,
    created_at: at(50),
    updated_at: at(50),
  });
  const b = await seedDiff(f, {
    type: 'pay_anomaly',
    ref_type: 'pay_anomaly',
    expected_fen: 0n,
    actual_fen: 990n,
    diff_fen: 990n,
    status: 'closed',
    closed_at: at(5),
    created_at: at(40),
    updated_at: at(5),
  });
  const c = await seedDiff(f, {
    type: 'pay_mismatch',
    ref_type: 'pay_refund',
    period: '2026-10-20',
    expected_fen: 0n,
    actual_fen: 500n,
    diff_fen: -500n,
    status: 'processing',
    created_at: at(30),
    updated_at: at(30),
  });
  // Not collection differences: other sources, and a pay type under another source.
  await seedDiff(f, {
    type: 'union_mismatch',
    source: 'R3',
    ref_type: 'order',
    created_at: at(20),
  });
  await seedDiff(f, {
    type: 'channel_mismatch',
    source: 'R2',
    ref_type: 'withdrawal',
    created_at: at(10),
  });
  await seedDiff(f, { type: 'pay_mismatch', source: 'R3', created_at: at(15) });
  const g = await fixture(s);
  await seedDiff(g, { created_at: at(1) });
  await withReconAdmin(f, async (h) => {
    const data = await page(await h.list());
    expect({ page: data.page, page_size: data.page_size, total: data.total }).toEqual({
      page: 1,
      page_size: 20,
      total: 3,
    });
    for (const item of data.items) expect(Object.keys(item).sort()).toEqual([...DIFF_KEYS]);
    expect(data.items.map(diffOf)).toEqual([c, b, a].map(diffView));
    const root = await h.caller([], { superAdmin: true });
    expect((await page(await h.list({}, root))).total).toBe(3);
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-15j#23] 对账差错列表的筛选与分页：type、status 按 AND 过滤，total 为过滤后的总数；page / page_size 翻页', async () => {
  const r = await recon(s);
  const f = r.f;
  const now = f.clock.now().getTime();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * MINUTE);
  const rows: DiffRow[] = [];
  for (const [index, [type, status]] of (
    [
      ['pay_mismatch', 'open'],
      ['pay_anomaly', 'open'],
      ['pay_mismatch', 'closed'],
      ['pay_anomaly', 'adjusted'],
      ['pay_mismatch', 'open'],
    ] as const
  ).entries()) {
    rows.push(
      await seedDiff(f, {
        type,
        status,
        ref_type: type === 'pay_anomaly' ? 'pay_anomaly' : 'pay_order',
        closed_at: status === 'closed' ? at(1) : null,
        created_at: at(50 - index * 10),
        updated_at: at(50 - index * 10),
      }),
    );
  }
  const [m1, a1, m2, a2, m3] = rows;
  await withReconAdmin(f, async (h) => {
    const ids = async (query: Record<string, string>, total: number) => {
      const data = await page(await h.list(query));
      expect(data.total, JSON.stringify(query)).toBe(total);
      return data.items.map((item) => item['recon_diff_id']);
    };
    expect(await ids({ type: 'pay_mismatch' }, 3)).toEqual([m3!.id, m2!.id, m1!.id]);
    expect(await ids({ type: 'pay_anomaly' }, 2)).toEqual([a2!.id, a1!.id]);
    expect(await ids({ status: 'open' }, 3)).toEqual([m3!.id, a1!.id, m1!.id]);
    expect(await ids({ type: 'pay_mismatch', status: 'open' }, 2)).toEqual([m3!.id, m1!.id]);
    expect(await ids({ type: 'pay_anomaly', status: 'closed' }, 0)).toEqual([]);
    const second = await page(await h.list({ page: '2', page_size: '2' }));
    expect({ page: second.page, page_size: second.page_size, total: second.total }).toEqual({
      page: 2,
      page_size: 2,
      total: 5,
    });
    expect(second.items.map((item) => item['recon_diff_id'])).toEqual([m2!.id, a1!.id]);
  });
});

it('[AC-B2-15j#24] 对账差错列表的拒绝：type 不是 R4 的收款类型（如 union_mismatch）或 status 不在枚举 → 20001 data.fields 指名该参数；page_size 超过 200 → 20001；没有 pay.view（只有 pay.refund 或 pay.resolve）10403，不带令牌 10001；空应用是空页', async () => {
  const r = await recon(s);
  await withReconAdmin(r.f, async (h) => {
    expect(await page(await h.list())).toEqual({ items: [], page: 1, page_size: 20, total: 0 });
    await answer(await h.list({ type: 'union_mismatch' }), 20001, { fields: ['type'] });
    await answer(await h.list({ status: 'resolved' }), 20001, { fields: ['status'] });
    await answer(await h.list({ page_size: '201' }), 20001);
    await answer(await h.list({}, await h.caller(['pay.refund'])), 10403);
    await answer(await h.list({}, await h.caller(['pay.resolve'])), 10403);
    await answer(await h.list({}, null), 10001);
  });
  expect(await allAudits(r.f)).toEqual([]);
});

it('[AC-B2-15j#25] 对账生成的差错单在列表里可见：状态 open，带结束处置所需的引用（PENDING 单的 pay_mismatch 指向该支付单，供补做查询后按 BR-PAY-04 / 05 结束；CLOSED 单收款的 pay_anomaly 指向登记的异常收款，供原路退款），period 为账单日', async () => {
  const r = await recon(s);
  const pending = await pendingOrder(r, 'wechat_pay');
  const closed = await closedOrder(r, 'wechat_pay');
  r.channels.wechat_pay.setBill(BILL_DATE, [lineOf(pending), lineOf(closed)]);
  await r.run('wechat_pay');
  const found = await anomalies(r.f);
  expect(found).toHaveLength(1);
  const anomaly = found[0]!;
  await withReconAdmin(r.f, async (h) => {
    const mismatch = await page(await h.list({ type: 'pay_mismatch' }));
    expect(mismatch.total).toBe(1);
    expect(mismatch.items[0]).toMatchObject({
      source: 'R4',
      type: 'pay_mismatch',
      period: BILL_DATE,
      ref_type: 'pay_order',
      ref_id: pending.id,
      status: 'open',
      closed_at: null,
    });
    const anomalyPage = await page(await h.list({ type: 'pay_anomaly', status: 'open' }));
    expect(anomalyPage.total).toBe(1);
    expect(anomalyPage.items[0]).toMatchObject({
      source: 'R4',
      type: 'pay_anomaly',
      period: BILL_DATE,
      ref_type: 'pay_anomaly',
      ref_id: anomaly.id,
      status: 'open',
      closed_at: null,
    });
  });
});
