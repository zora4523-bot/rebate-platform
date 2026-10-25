// B2-15f round 2 rule tests (claude-independent, SPEC_REF 736d24c5; 编排裁定 D10-357: needs_manual
// 进终态即清): 08 BR-PAY-05 ③ (needs_manual 由后台【立即查询】后按渠道结果结束：已支付 → PO2；已关闭，
// 或符合 ② 的不存在条件 → PO3), BR-PAY-04 (验签通过的通知与服务端主动查询同样 PO2), BR-PAY-02 (状态
// 迁移 CAS); contracts/openapi.yaml listAdminPayOrders (filter needs_manual) / getAdminPayOrder /
// resolveAdminPayOrder.
// A PENDING needs_manual pay order that reaches PAID (PO2: the admin resolve, a verified payment
// notification, a returned or scheduled query) or CLOSED (PO3: the resolve's closed / not-exist
// outcome) is stored with needs_manual=false, written by the same CAS as the status, and
// GET /admin/v1/pay-orders?needs_manual=true no longer lists it. Its manual history stays readable
// from the audit records and pay_query_attempts (no new column). An outcome that moves nothing keeps
// the flag (resolve.int.test.ts #4 / #5 / #6). The close flow never touches a needs_manual order
// (B2-15d), so PO3 here comes from the resolve. Nothing of the money changes: the PAY_RECEIPT rule
// (once per order) is asserted as before.
// Requests go through the real admin entry (kit.ts withAdmin), notifications through the api entry
// (../result/kit.ts withNotify), queries through the pay queue's handler (../result/kit.ts
// payJobHandler). Top-level it() only (规划/11 §4.3).
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  fixture,
  holdingBizLock,
  lockKey,
  payOrder,
  suite,
  track,
  untilWaiting,
  type Fixture,
  type OrderRow,
} from '../orders/kit.ts';
import {
  acked,
  attemptsOf,
  jobKit,
  paidNotification,
  payJobHandler,
  receiptOf,
  received,
  returnedQuery,
  vouchers,
  withNotify,
} from '../result/kit.ts';
import {
  CHANNELS,
  CONFLICT,
  adminChannels,
  answer,
  ok,
  orderOf,
  orderView,
  page,
  resolveAudits,
  seedAttempt,
  seedNeedsManual,
  withAdmin,
  type AdminHarness,
  type AdminSent,
  type AuditRow,
} from './kit.ts';

const s = suite();

const MINUTE = 60_000;

/** The order is terminal with needs_manual cleared (D10-357); the stored row. */
async function cleared(f: Fixture, order: OrderRow, status: 'PAID' | 'CLOSED'): Promise<OrderRow> {
  const row = await payOrder(f, order.id);
  expect(row, `${order.id} ${status}`).toMatchObject({ status, needs_manual: false });
  return row;
}

/**
 * The console's manual queue: ?needs_manual=true lists exactly `listed` (total included);
 * ?needs_manual=false lists every one of `gone`.
 */
async function manualQueue(
  h: AdminHarness,
  listed: readonly string[],
  gone: readonly string[],
): Promise<void> {
  const manual = await page(await h.list({ needs_manual: 'true' }));
  expect(manual.items.map((item) => String(item['pay_order_id'])).sort()).toEqual(
    [...listed].sort(),
  );
  expect(manual.total).toBe(listed.length);
  const rest = await page(await h.list({ needs_manual: 'false' }));
  const ids = rest.items.map((item) => item['pay_order_id']);
  for (const id of gone) expect(ids, `needs_manual=false lists ${id}`).toContain(id);
}

/** The detail shows the stored row, needs_manual false. */
async function detailCleared(h: AdminHarness, row: OrderRow): Promise<void> {
  const data = await ok(await h.detail(row.id));
  const shown = orderOf(data['pay_order']);
  expect(shown['needs_manual']).toBe(false);
  expect(shown).toEqual(orderView(row));
}

/** A resolve audit record keeps the manual history: needs_manual true before, false after. */
function auditedClear(audit: AuditRow | undefined, order: OrderRow): void {
  expect(audit).toBeDefined();
  expect(JSON.stringify(audit!.target) + JSON.stringify(audit!.before)).toContain(order.id);
  expect(JSON.stringify(audit!.before)).toContain('"needs_manual":true');
  expect(JSON.stringify(audit!.after)).toContain('"needs_manual":false');
}

interface AttemptFact {
  readonly kind: string;
  readonly result: string | null;
  readonly at: number;
}

/** A seeded attempt always carries a result (seedAttempt writes it). */
interface SeededAttempt extends AttemptFact {
  readonly result: string;
}

/** A resolve that won the race answers the PAID order with needs_manual false; a loser 20902. */
async function paidOrConflict(sent: AdminSent): Promise<void> {
  const code = sent.json().code;
  expect([0, 20902], sent.body).toContain(code);
  if (code === 0) {
    const data = await ok(sent);
    expect(orderOf(data['pay_order'])).toMatchObject({ status: 'PAID', needs_manual: false });
  } else {
    await answer(sent, 20902, CONFLICT);
  }
}

/** What B2-15d's close flow left before the hand-over: a not-paid query, an unknown close. */
async function closeFlowAttempts(f: Fixture, order: OrderRow): Promise<AttemptFact[]> {
  const expireAt = order.expire_at.getTime();
  const seeded: SeededAttempt[] = [
    { kind: 'query', result: 'not_paid', at: expireAt + MINUTE },
    { kind: 'close', result: 'unknown', at: expireAt + 2 * MINUTE },
  ];
  for (const attempt of seeded) {
    await seedAttempt(
      f,
      { payOrderId: order.id },
      {
        kind: attempt.kind === 'close' ? 'close' : 'query',
        result: attempt.result,
        at: new Date(attempt.at),
      },
    );
  }
  return seeded;
}

/** pay_query_attempts of the order as kind / result / at, oldest first. */
async function attemptFacts(f: Fixture, order: OrderRow): Promise<AttemptFact[]> {
  return (await attemptsOf(f, order.id)).map((attempt) => ({
    kind: attempt.kind,
    result: attempt.result,
    at: attempt.at.getTime(),
  }));
}

/** The close flow's attempts are still there, followed by exactly one query at `at`. */
async function historyKept(
  f: Fixture,
  order: OrderRow,
  history: readonly AttemptFact[],
  at: number | null,
): Promise<void> {
  const facts = await attemptFacts(f, order);
  expect(facts.slice(0, history.length)).toEqual([...history]);
  expect(facts.slice(history.length).map((fact) => [fact.kind, fact.at])).toEqual(
    at === null ? [] : [['query', at]],
  );
}

it.each(CHANNELS)(
  '[AC-B2-15f#23] %s 后台处置渠道已支付 → PO2：库里 status=PAID 且 needs_manual=false（与状态同一次写入），应答与详情的 pay_order.needs_manual=false；GET /admin/v1/pay-orders?needs_manual=true 不再列出该单（仍列出另一张未处置的 needs_manual 单），needs_manual=false 列出它；需人工的历史仍在：处置审计前 needs_manual=true、后 false，关单流程留下的与本次查询的 pay_query_attempts 都在；PAY_RECEIPT 仍只一张',
  async (channel) => {
    const f = await fixture(s);
    const channels = adminChannels(f);
    const order = await seedNeedsManual(f, channel);
    const waiting = await seedNeedsManual(f, channel);
    const history = await closeFlowAttempts(f, order);
    channels[channel].script(order, 'paid');
    f.clock.advanceMs(MINUTE);
    await withAdmin(f, channels, async (h) => {
      await manualQueue(h, [order.id, waiting.id], []);
      const data = await ok(await h.resolve(order.id));
      const row = await cleared(f, order, 'PAID');
      expect(orderOf(data['pay_order'])).toEqual(orderView(row));
      expect(orderOf(data['pay_order'])['needs_manual']).toBe(false);
      await detailCleared(h, row);
      await manualQueue(h, [waiting.id], [order.id]);
      const audits = await resolveAudits(f);
      expect(audits).toHaveLength(1);
      auditedClear(audits[0], order);
      await historyKept(f, order, history, f.clock.now().getTime());
      expect(await payOrder(f, waiting.id)).toEqual(waiting);
    });
    expect(await vouchers(f)).toEqual([receiptOf(await payOrder(f, order.id))]);
  },
);

it.each([
  ['渠道明确已关闭', 'closed'],
  ['过了宽限渠道仍答单据不存在', 'not_exist'],
] as const)(
  '[AC-B2-15f#24] 后台处置%s → PO3：库里 status=CLOSED 且 needs_manual=false，应答与详情 needs_manual=false；needs_manual=true 的列表不再列出该单、needs_manual=false 列出它；处置审计前 needs_manual=true、后 false；无收款分录；再处置 20902',
  async (label, setting) => {
    const f = await fixture(s);
    const channels = adminChannels(f);
    const order = await seedNeedsManual(f, 'alipay');
    channels.alipay.script(order, setting);
    f.clock.advanceMs(MINUTE);
    await withAdmin(f, channels, async (h) => {
      const data = await ok(await h.resolve(order.id));
      const row = await cleared(f, order, 'CLOSED');
      expect(orderOf(data['pay_order']), label).toEqual(orderView(row));
      expect(orderOf(data['pay_order'])['needs_manual']).toBe(false);
      await detailCleared(h, row);
      await manualQueue(h, [], [order.id]);
      const audits = await resolveAudits(f);
      expect(audits).toHaveLength(1);
      auditedClear(audits[0], order);
      // Terminal now: refused before any query, the cleared row untouched.
      await answer(await h.resolve(order.id), 20902, CONFLICT);
      expect(channels.alipay.queried).toEqual([order.out_trade_no]);
      expect(await payOrder(f, order.id)).toEqual(row);
    });
    expect(await vouchers(f)).toEqual([]);
  },
);

it.each(CHANNELS)(
  '[AC-B2-15f#25] %s needs_manual 支付单收到验签通过的成功通知 → PO2：通知应答成功，库里 PAID 且 needs_manual=false；处置前 needs_manual=true 的列表列出该单，通知后不再列出、详情 needs_manual=false；关单流程留下的 pay_query_attempts 仍在（不删历史）；PAY_RECEIPT 一张',
  async (channel) => {
    const f = await fixture(s);
    const channels = adminChannels(f);
    const order = await seedNeedsManual(f, channel);
    const history = await closeFlowAttempts(f, order);
    const built = paidNotification(channels, channels[channel].identity, order);
    f.clock.advanceMs(MINUTE);
    await withAdmin(f, channels, async (h) => {
      await manualQueue(h, [order.id], []);
      await withNotify(f, channels, async (n) => {
        acked(channel, await n.deliver(channel, built.raw));
      });
      const row = await cleared(f, order, 'PAID');
      await detailCleared(h, row);
      await manualQueue(h, [], [order.id]);
    });
    await historyKept(f, order, history, null);
    expect(await resolveAudits(f)).toEqual([]);
    expect(await vouchers(f)).toEqual([receiptOf(await payOrder(f, order.id))]);
  },
);

it.each([
  ['客户端返回触发的主动查询', 'returned'],
  ['定时查询', 'scheduled'],
] as const)(
  '[AC-B2-15f#26] needs_manual 支付单经%s（order.query，渠道答已支付）→ PO2：库里 PAID 且 needs_manual=false；needs_manual=true 的列表不再列出、详情 needs_manual=false；关单流程留下的与本次查询的 pay_query_attempts 都在；PAY_RECEIPT 一张',
  async (label, trigger) => {
    const f = await fixture(s);
    const channels = adminChannels(f);
    const order = await seedNeedsManual(f, 'wechat_pay');
    const history = await closeFlowAttempts(f, order);
    channels.wechat_pay.script(order, 'paid');
    f.clock.advanceMs(MINUTE);
    const handle = await payJobHandler(await jobKit(f, channels));
    await handle(
      trigger === 'returned'
        ? returnedQuery(order)
        : received('order.query', {
            app_id: order.app_id,
            out_trade_no: order.out_trade_no,
            trigger: 'scheduled',
          }),
    );
    expect(channels.wechat_pay.queried, label).toEqual([order.out_trade_no]);
    const row = await cleared(f, order, 'PAID');
    await historyKept(f, order, history, f.clock.now().getTime());
    await withAdmin(f, channels, async (h) => {
      await detailCleared(h, row);
      await manualQueue(h, [], [order.id]);
    });
    expect(await vouchers(f)).toEqual([receiptOf(row)]);
  },
);

it('[AC-B2-15f#27] 真实并发：后台处置（渠道答已支付）与成功通知在业务对象锁后排队，只生效一次，且清标志随那一次 CAS 一起写入——库里 PAID、needs_manual=false，一张 PAY_RECEIPT；处置应答为 needs_manual=false 的已支付单或 20902；needs_manual=true 的列表不再列出该单', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  const order = await seedNeedsManual(f, 'wechat_pay');
  const trade = channels.wechat_pay.script(order, 'paid');
  const built = paidNotification(channels, channels.wechat_pay.identity, order, {
    channelTradeNo: trade,
  });
  await withAdmin(f, channels, async (h) => {
    const token = await h.stepUp(h.resolver);
    await withNotify(f, channels, async (n) => {
      const key = lockKey(f, order.biz_ref);
      const [resolved, delivered] = await holdingBizLock(f, key, async (release) => {
        const resolving = track(h.resolve(order.id, { stepUp: token }));
        const delivering = track(n.deliver('wechat_pay', built.raw));
        const waiting = await untilWaiting(f, key, 2, [resolving, delivering]);
        await release();
        const results = await Promise.all([resolving.promise, delivering.promise]);
        expect(waiting, 'the resolve and the notification both wait for the lock').toBe(true);
        return results;
      });
      acked('wechat_pay', delivered);
      await paidOrConflict(resolved);
    });
    const row = await cleared(f, order, 'PAID');
    expect(row.channel_trade_no).toBe(trade);
    await manualQueue(h, [], [order.id]);
    expect(await vouchers(f)).toEqual([receiptOf(row)]);
  });
});

it('[AC-B2-15f#28] 不迁移的处置保留标志、进终态才清：处置时渠道仍未支付 → 仍 PENDING、needs_manual=true、仍在 needs_manual=true 的列表；随后定时查询答已支付 → PAID、needs_manual=false、列表不再列出；第一次处置的审计（前后都是 needs_manual=true）与两次查询的 pay_query_attempts 都还在；pay_orders 没有为此新增列', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  const order = await seedNeedsManual(f, 'alipay');
  channels.alipay.script(order, 'not_paid');
  f.clock.advanceMs(MINUTE);
  const firstAt = f.clock.now().getTime();
  await withAdmin(f, channels, async (h) => {
    const data = await ok(await h.resolve(order.id));
    expect(orderOf(data['pay_order'])).toMatchObject({ status: 'PENDING', needs_manual: true });
    expect(await payOrder(f, order.id)).toMatchObject({ status: 'PENDING', needs_manual: true });
    await manualQueue(h, [order.id], []);
  });
  channels.alipay.script(order, 'paid');
  f.clock.advanceMs(MINUTE);
  const handle = await payJobHandler(await jobKit(f, channels));
  await handle(
    received('order.query', {
      app_id: order.app_id,
      out_trade_no: order.out_trade_no,
      trigger: 'scheduled',
    }),
  );
  const row = await cleared(f, order, 'PAID');
  await withAdmin(f, channels, async (h) => {
    await detailCleared(h, row);
    await manualQueue(h, [], [order.id]);
  });
  const audits = await resolveAudits(f);
  expect(audits).toHaveLength(1);
  expect(audits[0]!.at.getTime()).toBe(firstAt);
  expect(JSON.stringify(audits[0]!.before)).toContain('"needs_manual":true');
  expect(JSON.stringify(audits[0]!.after)).toContain('"needs_manual":true');
  expect((await attemptFacts(f, order)).map((attempt) => [attempt.kind, attempt.at])).toEqual([
    ['query', firstAt],
    ['query', f.clock.now().getTime()],
  ]);
  const columns = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'pay_orders' AND column_name LIKE '%manual%'
    ORDER BY column_name`.execute(f.db);
  expect(columns.rows.map((column) => column.column_name)).toEqual(['needs_manual']);
  expect(await vouchers(f)).toEqual([receiptOf(row)]);
});
