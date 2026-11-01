// B1-09p · 批量读不串单：一页多单、Agent 列表 8 条各归各单；同一子单号跨平台、跨 App 互不影响。
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  EXPECTED,
  PAID_MONTH,
  credited,
  fixture,
  useDatabase,
  waiting,
  type OrderPatch,
} from './kit.ts';

const pg = useDatabase(createTestDatabase);

it('[AC-B1-09p#49][BR-FUND-17][BR-TEXT-02] 列表多单：金额与状态各归各单，比例取各单快照', async () => {
  const f = await fixture(pg.db);
  const small = await f.order();
  const big = await f.order({ patch: waiting({ est_commission_fen: 2000n }) });
  const reserved = await f.order({ reserveBp: 2000 });
  const empty = await f.order({ patch: { est_commission_fen: 0n } });
  const unknown = await f.bareOrder();
  const page = await (await f.queries()).list(f.subject, { scope: 'self' });
  const seen = new Map(page.items.map((item) => [item.order_id, item]));
  expect(seen.get(small.orderId)).toMatchObject({ display_status: 'PAID', est_rebate_fen: 425 });
  expect(seen.get(big.orderId)).toMatchObject({ display_status: 'WAITING', est_rebate_fen: 850 });
  expect(seen.get(reserved.orderId)).toMatchObject({ display_status: 'PAID', est_rebate_fen: 400 });
  expect(seen.get(empty.orderId)).toMatchObject({
    display_status: 'NO_REBATE',
    est_rebate_fen: null,
  });
  expect(seen.get(unknown.orderId)).toMatchObject({ display_status: 'PAID', est_rebate_fen: null });
}, 60_000);

it('[AC-B1-09p#50][BR-AI-07][BR-FUND-04] Agent 列表 8 条：金额、月份、状态各归各单，分享单与平台偏移也不串', async () => {
  const f = await fixture(pg.db, { config: { 'settle.period_offset_months.pdd': 2 } });
  const cases: {
    readonly patch: OrderPatch;
    readonly est: number;
    readonly period: string | null;
    readonly status: string;
  }[] = [
    { patch: { est_commission_fen: 1000n }, est: 425, period: null, status: 'PAID' },
    { patch: { est_commission_fen: 2000n }, est: 850, period: null, status: 'PAID' },
    {
      patch: waiting({ est_commission_fen: 3000n }),
      est: 1275,
      period: EXPECTED,
      status: 'WAITING',
    },
    {
      patch: waiting({ est_commission_fen: 4000n, settle_period: '2027-12' }),
      est: 1700,
      period: '2028-01',
      status: 'WAITING',
    },
    {
      patch: waiting({ est_commission_fen: 5000n, platform: 'pdd' }),
      est: 2125,
      period: '2028-01',
      status: 'WAITING',
    },
    {
      patch: waiting({ est_commission_fen: 6000n, hold: true }),
      est: 2550,
      period: null,
      status: 'REVIEWING',
    },
    {
      patch: waiting({ est_commission_fen: 7000n, rights_pending: true }),
      est: 2975,
      period: null,
      status: 'RIGHTS_PENDING',
    },
    {
      patch: waiting({ est_commission_fen: 8000n, union_settled_at: '2027-11-20T04:00:00.000Z' }),
      est: 3400,
      period: '2027-11',
      status: 'CREDITING',
    },
  ];
  const expected = new Map<string, unknown>();
  for (const item of cases) {
    const o = await f.order({ patch: item.patch });
    expected.set(o.orderId, {
      est_rebate_fen: item.est,
      expected_credit_period: item.period,
      display_status: item.status,
    });
  }
  const stranger = await f.user();
  await f.order({ patch: { user_id: stranger } });
  const found = await (await f.queries()).searchForAgent(f.subject, PAID_MONTH);
  expect(found.total).toBe(8);
  expect(found.orders).toHaveLength(8);
  expect(
    new Map(
      found.orders.map((item) => [
        item.order_id,
        {
          est_rebate_fen: item.est_rebate_fen,
          expected_credit_period: item.expected_credit_period,
          display_status: item.display_status,
        },
      ]),
    ),
  ).toEqual(expected);
}, 90_000);

it('[AC-B1-09p#51][BR-AI-07] Agent 按单号查：卡片金额是这一单的', async () => {
  const f = await fixture(pg.db);
  await f.order({ patch: { est_commission_fen: 1000n } });
  const wanted = await f.order({ patch: { est_commission_fen: 2000n } });
  const found = await (
    await f.queries()
  ).findOwnByNumber(f.subject, {
    order_no: wanted.subOrderId,
  });
  expect(found.map((item) => [item.order_id, item.est_rebate_fen])).toEqual([
    [wanted.orderId, 850],
  ]);
}, 60_000);

it('[AC-B1-09p#52][BR-TEXT-02] 同一子单号在两个平台：分录按平台归单，不串', async () => {
  const f = await fixture(pg.db);
  const sub = `same-${randomUUID()}`;
  const jd = await f.order({ patch: credited({ platform: 'jd', sub_order_id: sub }) });
  const pdd = await f.order({ patch: credited({ platform: 'pdd', sub_order_id: sub }) });
  await f.credit(jd, { amount: 425n });
  await f.clawback(jd, { amount: 100n });
  await f.credit(pdd, { amount: 300n });
  const page = await (await f.queries()).list(f.subject, { scope: 'self' });
  const seen = new Map(page.items.map((item) => [item.order_id, item.display_status]));
  expect(seen.get(jd.orderId)).toBe('CREDITED_PART_CLAWED');
  expect(seen.get(pdd.orderId)).toBe('CREDITED');
  expect(await f.detail(jd)).toMatchObject({ actual_fen: 325, clawback_fen: 100 });
  expect(await f.detail(pdd)).toMatchObject({ actual_fen: 300, clawback_fen: 0 });
}, 60_000);

it('[AC-B1-09p#53][BR-TEXT-02] 别的 App 里同用户、同 order_key 的分录不串', async () => {
  const f = await fixture(pg.db);
  // order_keys is keyed on (platform, sub_order_id) across apps, so the other app cannot hold this
  // order, but ledger_vouchers.order_key is a plain column of each app's ledger. With the same user
  // id and the same key, app_id is all that tells these entries apart. beneficiary_credits cannot
  // repeat this way: its order reference is (app_id, order_id) and order_id is unique across apps.
  const foreign = await fixture(pg.db, {
    subject: { app_id: `figures-${randomUUID()}`, user_id: f.subject.user_id },
  });
  const o = await f.order({ patch: credited() });
  await f.credit(o, { amount: 425n });
  await foreign.credit(o, { amount: 200n });
  await foreign.adjust(o, { amount: 30n });
  await foreign.clawback(o, { amount: 50n });
  expect(await f.detail(o)).toMatchObject({
    display_status: 'CREDITED',
    actual_fen: 425,
    clawback_fen: 0,
  });
  expect(await f.row(o)).toMatchObject({ display_status: 'CREDITED' });
}, 60_000);

it('[AC-B1-09p#54][BR-TEXT-02] 翻页读到的每一页都带真实金额', async () => {
  const f = await fixture(pg.db);
  const older = await f.order({ patch: { est_commission_fen: 1000n } });
  const newer = await f.order({ patch: { est_commission_fen: 2000n } });
  const q = await f.queries();
  const first = await q.list(f.subject, { scope: 'self', limit: 1 });
  expect(first.items.map((item) => [item.order_id, item.est_rebate_fen])).toEqual([
    [newer.orderId, 850],
  ]);
  expect(first.next_cursor).not.toBeNull();
  const second = await q.list(f.subject, {
    scope: 'self',
    limit: 1,
    cursor: first.next_cursor ?? '',
  });
  expect(second.items.map((item) => [item.order_id, item.est_rebate_fen])).toEqual([
    [older.orderId, 425],
  ]);
}, 60_000);
