// B1-09p · 生产装配（api 入口）：真实 AppModule 组出的 OrderQueries，真实令牌、真实 PG 与 Redis，
// HTTP 经 inject。这一缺口正是生产空转造成的：此处不注入任何端口，骨架上生产仍回落
// createUnknownOrderFigures，所以红在断言。BR-FUND-18：与 GET /v1/wallet/summary 同单同数。
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { Response } from '../../identity/sms-codes/http-kit.ts';
import { WALLET, wallet } from '../../identity/me-balance/kit.ts';
import {
  closeKit,
  consentAll,
  fixture as member,
  openKit,
  type Kit,
} from '../../identity/me/http-kit.ts';
import { credited, fixture, waiting, type OrderPatch } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 120_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

const TIMEOUT = 60_000;
const LIST = '/v1/orders';
const DETAIL = '/v1/orders/{order_id}';
// member() sets the Clock to 2031-05-06T08:08:09Z.
const PAID_AT = '2031-04-02T02:00:00.000Z';
const RECEIVED_AT = '2031-04-10T02:00:00.000Z';
const BOOKED_AT = '2031-05-02T02:00:00.000Z';
const CLAWED_AT = '2031-05-03T02:00:00.000Z';
/** settle_period 2031-04 → expected 2031-05, deadline 2031-06-03: not overdue at the Clock. */
const open: OrderPatch = { paid_at: PAID_AT, received_at: RECEIVED_AT, settle_period: '2031-04' };

function data<T>(response: Response, path: string): T {
  expect(response.statusCode).toBe(200);
  const body = response.json<{ code: number; data: T }>();
  expect(body).toMatchObject({ code: 0 });
  const schema =
    kit.document.paths[path]!['get']!.responses['200']!.content['application/json']!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body.data;
}

async function memberFixture() {
  const m = await member(kit);
  await consentAll(kit, m);
  const f = await fixture(kit.suite.db, {
    now: kit.clock.now().toISOString(),
    subject: { app_id: m.appId, user_id: m.uid },
  });
  const session = await m.session();
  return {
    f,
    list: async (scope: 'self' | 'share') =>
      data<Schema<'OrderListData'>>(await session.request(`${LIST}?scope=${scope}`), LIST),
    get: async (orderId: string) =>
      data<Schema<'OrderDetail'>>(await session.request(`${LIST}/${orderId}`), DETAIL),
    wallet: async () => wallet(kit, await session.request(WALLET)),
  };
}

it(
  '[AC-B1-09p#55][BR-FUND-18][BR-TEXT-02] 生产 /v1/orders 与 /v1/wallet/summary 同单同数，含分享单与 hold 单',
  async () => {
    const m = await memberFixture();
    const estimated = await m.f.order({ patch: { paid_at: PAID_AT } });
    const shared = await m.f.order({
      patch: { paid_at: PAID_AT, buy_type: 'share' },
      people: [{ userId: m.f.subject.user_id, role: 'share', ratioBp: 4000 }],
    });
    const pending = await m.f.order({ patch: waiting({ ...open, est_commission_fen: 2000n }) });
    const held = await m.f.order({ patch: waiting({ ...open, hold: true }) });

    const summary = await m.wallet();
    expect(summary['estimated_fen']).toBe(765);
    expect(summary['pending_credit_fen']).toBe(1275);
    expect(summary['pending_credit_paused_fen']).toBe(425);

    const self = await m.list('self');
    const share = await m.list('share');
    const amount = (page: Schema<'OrderListData'>, id: string) =>
      page.items.find((item) => item.order_id === id)?.est_rebate_fen ?? 0;
    const estimatedFen = amount(self, estimated.orderId);
    const sharedFen = amount(share, shared.orderId);
    const pendingFen = amount(self, pending.orderId);
    const heldFen = amount(self, held.orderId);
    expect([estimatedFen, sharedFen, pendingFen, heldFen]).toEqual([425, 340, 850, 425]);
    expect(estimatedFen + sharedFen).toBe(summary['estimated_fen']);
    expect(pendingFen + heldFen).toBe(summary['pending_credit_fen']);
    expect(heldFen).toBe(summary['pending_credit_paused_fen']);
  },
  TIMEOUT,
);

it(
  '[AC-B1-09p#56][BR-TEXT-02][BR-ID-36] 生产详情：实返、扣回、最近一次扣回时间、申诉中都来自真实行',
  async () => {
    const m = await memberFixture();
    const o = await m.f.order({ patch: credited({ ...open, credited_at: BOOKED_AT }) });
    await m.f.credit(o, { amount: 425n, at: BOOKED_AT });
    await m.f.clawback(o, { amount: 100n, at: CLAWED_AT });
    await m.f.appeal(o);

    const detail = await m.get(o.orderId);
    expect(detail).toMatchObject({
      display_status: 'CREDITED_PART_CLAWED',
      actual_fen: 325,
      clawback_fen: 100,
      appeal_pending: true,
    });
    const node = detail.timeline.find((item) => item.node === 'part_clawed_back');
    expect(Date.parse(node?.at ?? '')).toBe(Date.parse(CLAWED_AT));
    const page = await m.list('self');
    expect(page.items.map((item) => item.display_status)).toEqual(['CREDITED_PART_CLAWED']);
  },
  TIMEOUT,
);

it(
  '[AC-B1-09p#57][BR-FUND-04][BR-FUND-17] 生产列表与详情：b_est=0、逾期、本人暂缓都按真实数据派生',
  async () => {
    const m = await memberFixture();
    const empty = await m.f.order({
      patch: { paid_at: PAID_AT, est_commission_fen: 0n },
    });
    // settle_period 2031-03 → expected 2031-04, deadline 2031-05-04, before the Clock.
    const overdue = await m.f.order({ patch: waiting({ ...open, settle_period: '2031-03' }) });
    const held = await m.f.order({ patch: credited(open) });
    await m.f.obligation(held, { kind: 'first_credit' });

    const page = await m.list('self');
    const status = (id: string) => page.items.find((item) => item.order_id === id)?.display_status;
    expect(status(empty.orderId)).toBe('NO_REBATE');
    expect(status(overdue.orderId)).toBe('CREDITING');
    expect(status(held.orderId)).toBe('REVIEWING');
    expect(await m.get(overdue.orderId)).toMatchObject({
      credit_overdue: true,
      expected_credit_period: '2031-04',
    });
  },
  TIMEOUT,
);
