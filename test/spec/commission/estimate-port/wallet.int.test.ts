// B2-03q · 端到端（D10-565；w1 B1-09p money r1 核出的钱包缺陷）：真实 AppModule、真实 PG 与 Redis，HTTP 经 inject；
// 版本由 orders 同步推进，金额行由真实 rebate + 真实 refresh 写，/v1/wallet/summary 不抛错，且与订单页同单同数
// （BR-FUND-18、BR-TEXT-02）。此处没有假端口：缺版本行时钱包整个 500。
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { AT } from '../../settlement/pending-earnings/fixtures.ts';
import { WALLET, wallet } from '../../identity/me-balance/kit.ts';
import {
  closeKit,
  consentAll,
  fixture as member,
  openKit,
  type Kit,
} from '../../identity/me/http-kit.ts';
import type { Response } from '../../identity/sms-codes/http-kit.ts';
import { fixture, waiting, type OrderPatch } from '../../orders/figures/kit.ts';
import {
  amountsAt,
  estimatesOf,
  rebateOf,
  storedVersions,
  syncColumns,
  type SyncSpec,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 120_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

const TIMEOUT = 60_000;
const LIST = '/v1/orders';
// member() sets the Clock to 2031-05-06T08:08:09Z.
const PAID_AT = '2031-04-02T02:00:00.000Z';
const RECEIVED_AT = '2031-04-10T02:00:00.000Z';
const open: OrderPatch = { paid_at: PAID_AT, received_at: RECEIVED_AT, settle_period: '2031-04' };

function listOf(response: Response): Schema<'OrderListData'> {
  expect(response.statusCode).toBe(200);
  const body = response.json<{ code: number; data: Schema<'OrderListData'> }>();
  expect(body).toMatchObject({ code: 0 });
  const schema =
    kit.document.paths[LIST]!['get']!.responses['200']!.content['application/json']!.schema;
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
  const clock = new FixedClock(kit.clock.now().toISOString());
  const rebate = rebateOf(clock, estimatesOf(clock));

  /** One orders sync: the columns, then the real rebate with the real estimates, on one trx. */
  async function sync(
    order: { orderId: string; platform: string; subOrderId: string },
    spec: SyncSpec,
  ) {
    await f.db.transaction().execute(async (trx) => {
      const { change, source } = await syncColumns(
        trx,
        { ...order, appId: m.appId, attrAt: AT },
        spec,
      );
      await rebate.onUpdated(trx, change, source);
    });
  }

  return {
    f,
    m,
    sync,
    own: (order: { orderId: string; platform: string; subOrderId: string }) => ({
      ...order,
      appId: m.appId,
      attrAt: AT,
    }),
    wallet: async () => wallet(kit, await session.request(WALLET)),
    amount: async (orderId: string) => {
      const page = listOf(await session.request(`${LIST}?scope=self`));
      return page.items.find((item) => item.order_id === orderId)?.est_rebate_fen;
    },
  };
}

it(
  '[AC-B2-03q#47][BR-FUND-18][BR-TEXT-02] 佣金变化后钱包不抛错，ESTIMATED 与 WAITING 都与订单页同单同数',
  async () => {
    const m = await memberFixture();
    const estimated = await m.f.order({ patch: { paid_at: PAID_AT } });
    const pending = await m.f.order({ patch: waiting(open) });

    await m.sync(estimated, { estAfter: 2000n });
    await m.sync(pending, { estAfter: 3000n });

    // 2000 × 85% × 50% = 850；3000 × 85% × 50% = 1275。
    const summary = await m.wallet();
    expect(summary['estimated_fen']).toBe(850);
    expect(summary['pending_credit_fen']).toBe(1275);
    expect(await m.amount(estimated.orderId)).toBe(summary['estimated_fen']);
    expect(await m.amount(pending.orderId)).toBe(summary['pending_credit_fen']);
    expect(await amountsAt(m.f.db, m.own(estimated), 2)).toEqual([['self', 1700n, 850n]]);
    expect(await amountsAt(m.f.db, m.own(pending), 2)).toEqual([['self', 2550n, 1275n]]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-03q#48][BR-FUND-18] 连续两次佣金变化：钱包取最新版本，v1、v2、v3 都在',
  async () => {
    const m = await memberFixture();
    const o = await m.f.order({ patch: { paid_at: PAID_AT } });

    await m.sync(o, { estAfter: 2000n });
    await m.sync(o, { estAfter: 1200n });

    // 1200 × 85% × 50% = 510。
    const summary = await m.wallet();
    expect(summary['estimated_fen']).toBe(510);
    expect(await m.amount(o.orderId)).toBe(510);
    expect(await storedVersions(m.f.db, m.own(o))).toEqual({
      amounts: [1, 2, 3],
      totals: [1, 2, 3],
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03q#49][BR-FUND-18] 版本跳号：未归因期间 +2、快照才写 v1 的单，归因后钱包正常，与订单页同数',
  async () => {
    const m = await memberFixture();
    const o = await m.f.order({
      patch: {
        paid_at: PAID_AT,
        rebate_status: 'UNATTRIBUTED',
        commission_version: 3,
        est_commission_fen: 1600n,
      },
    });

    await m.sync(o, { attributedNow: true });

    // 1600 × 85% × 50% = 680。
    const summary = await m.wallet();
    expect(summary['estimated_fen']).toBe(680);
    expect(await m.amount(o.orderId)).toBe(680);
    expect(await storedVersions(m.f.db, m.own(o))).toEqual({ amounts: [1, 3], totals: [1, 3] });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03q#50][BR-FUND-03][BR-FUND-18] 结算后预估单独变化：版本前进、结算额不变，钱包不抛错，金额仍按结算额',
  async () => {
    const m = await memberFixture();
    const o = await m.f.order({
      patch: waiting({
        ...open,
        platform_status: 'SETTLED',
        est_commission_fen: 1000n,
        settle_commission_fen: 1000n,
      }),
    });

    await m.sync(o, { estAfter: 3000n, event: 'PLATFORM_SETTLED' });

    const summary = await m.wallet();
    expect(summary['pending_credit_fen']).toBe(425);
    expect(await m.amount(o.orderId)).toBe(425);
  },
  TIMEOUT,
);
