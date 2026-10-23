import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createBatchCommandService } from '../../../../apps/api/src/modules/settlement/batch/commands/service.ts';
import {
  databaseFixture,
  fixture,
  itemsOf,
  main,
  mains,
  order,
  settlement,
  state,
  supplements,
  LATER,
  MONTH,
  TIMEOUT,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

// BR-FUND-04 ⑤⑥⑧、SB1：补充批次生成即 DRAFT，与首批分开、单独确认；生成不入账。

it(
  '[AC-B2-04r#10] 补充批次 kind=supplement、DRAFT、挂在同一账单、未确认；返回本轮批次，生成不入账',
  async () => {
    const h = fixture(database.db);
    const a = await order(h, { hold: true });
    const b = await order(h, { rightsPending: true });
    for (const o of [a, b]) await settlement(h, o);
    await main(h);
    a.fact.order.hold = false;
    b.fact.order.rightsPending = false;
    const before = await state(h);

    const result = await h.launch();
    const s = await state(h);
    const batches = supplements(s);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      app_id: h.appId,
      bill_id: MONTH,
      platform: 'taobao',
      kind: 'supplement',
      status: 'DRAFT',
      settle_mode: 'IMMEDIATE',
      scheduled_at: null,
      confirmed_by: null,
      confirmed_at: null,
      cancelled_reason: null,
      settle_run_id: null,
      order_count: 2,
      started_at: null,
      finished_at: null,
      paused_by_switch_at: null,
    });
    expect(result).toMatchObject({
      outcome: 'generated',
      billId: MONTH,
      platform: 'taobao',
      batchIds: [batches[0]!.batch_id],
    });
    for (const item of itemsOf(s, batches)) {
      expect(item).toMatchObject({
        item_type: 'order',
        settle_seq: 1,
        b_settle_fen: 850n,
        amount_fen: null,
        result: null,
        skip_reason: null,
        user_id: null,
        role: null,
        beneficiary_credit_id: null,
      });
    }
    expect(s.vouchers).toEqual(before.vouchers);
    expect(s.balances).toEqual(before.balances);
    expect(s.obligations).toEqual(before.obligations);
    expect(s.diffs).toEqual(before.diffs);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#11] 补充不改首批批次与明细、账单日校验记录和账单生成时刻',
  async () => {
    const h = fixture(database.db);
    const first = await order(h);
    await settlement(h, first);
    const held = await order(h, { hold: true });
    await settlement(h, held);
    await main(h);
    held.fact.order.hold = false;
    const before = await state(h);
    expect(mains(before)).toHaveLength(1);

    await h.launch();
    const s = await state(h);
    expect(mains(s)).toEqual(mains(before));
    expect(itemsOf(s, mains(s))).toEqual(itemsOf(before, mains(before)));
    expect(s.validations).toEqual(before.validations);
    expect(s.bills).toHaveLength(1);
    expect(s.bills[0]).toMatchObject({
      bill_id: MONTH,
      generation_started_at: before.bills[0]!.generation_started_at,
      generated_at: before.bills[0]!.generated_at,
    });
    expect(itemsOf(s, supplements(s))).toContainEqual(
      expect.objectContaining({ item_type: 'order', order_id: held.id }),
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#12] 补充候选同样按 settle.batch.max_orders 与 order_key 升序拆批',
  async () => {
    const h = fixture(database.db);
    await main(h);
    h.values.set('settle.batch.max_orders', 2);
    const orders = [];
    for (let i = 0; i < 5; i += 1) {
      const o = await order(h);
      await settlement(h, o, { created_at: new Date(LATER) });
      orders.push(o);
    }
    h.facts.sort((x, y) => (x.orderKey < y.orderKey ? 1 : -1));

    const result = await h.launch();
    const s = await state(h);
    const batches = supplements(s);
    expect(batches).toHaveLength(3);
    expect([...result.batchIds].sort()).toEqual(batches.map((b) => b.batch_id).sort());
    const sorted = [...orders].sort((x, y) => (x.key < y.key ? -1 : 1)).map((o) => o.id);
    const groups = batches
      .map((b) =>
        s.items
          .filter((i) => i.batch_id === b.batch_id)
          .map((i) => i.order_id)
          .sort()
          .join(','),
      )
      .sort();
    expect(groups).toEqual(
      [sorted.slice(0, 2), sorted.slice(2, 4), sorted.slice(4)]
        .map((g) => g.sort().join(','))
        .sort(),
    );
    for (const batch of batches) {
      expect(batch).toMatchObject({ kind: 'supplement', status: 'DRAFT', bill_id: MONTH });
      expect(batch.order_count).toBe(s.items.filter((i) => i.batch_id === batch.batch_id).length);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#13] 首批被驳回（CANCELLED）后批内订单仍为 WAITING，可进入补充批次',
  async () => {
    const h = fixture(database.db);
    const o = await order(h);
    await settlement(h, o);
    await main(h);
    const [rejected] = (await state(h)).batches;
    await h.db
      .withSchema('app')
      .updateTable('settle_batches')
      .set({ status: 'CANCELLED', cancelled_reason: '财务驳回' })
      .where('app_id', '=', h.appId)
      .where('batch_id', '=', rejected!.batch_id)
      .execute();

    await h.launch();
    const s = await state(h);
    expect(mains(s)).toEqual([
      expect.objectContaining({ batch_id: rejected!.batch_id, status: 'CANCELLED' }),
    ]);
    expect(itemsOf(s, supplements(s))).toEqual([
      expect.objectContaining({ item_type: 'order', order_id: o.id, b_settle_fen: 850n }),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04r#14] 补充批次须单独确认：确认本轮补充批次不动首批，首批也不因补充而被确认',
  async () => {
    const h = fixture(database.db);
    const first = await order(h);
    await settlement(h, first);
    const held = await order(h, { hold: true });
    await settlement(h, held);
    await main(h);
    held.fact.order.hold = false;
    const adminId = randomUUID();
    await h.db
      .withSchema('app')
      .insertInto('admin_users')
      .values({
        id: adminId,
        app_id: h.appId,
        login_name: adminId,
        password_hash: 'test-only',
        is_super: true,
        status: 'active',
      })
      .execute();
    const [mainBatch] = mains(await state(h));

    const result = await h.launch();
    const launched = await state(h);
    expect(mains(launched)).toEqual([mainBatch]);
    const drafts = supplements(launched);
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((b) => b.status === 'DRAFT' && b.confirmed_at === null)).toBe(true);
    expect([...result.batchIds].sort()).toEqual(drafts.map((b) => b.batch_id).sort());

    const service = createBatchCommandService({
      db: h.db,
      clock: h.clock,
      currentRound: async () => [...result.batchIds],
      readiness: async () => ({
        autoEnabled: true,
        creditEnabled: true,
        snapshotCompleted: true,
        snapshotTimedOut: false,
      }),
    });
    await service.confirmBill({
      appId: h.appId,
      adminId,
      billId: MONTH,
      expectedBatches: drafts.map((b) => ({
        batchId: b.batch_id,
        expectedRowVersion: b.row_version,
      })),
    });
    const s = await state(h);
    expect(mains(s)).toEqual([mainBatch]);
    for (const b of supplements(s)) {
      expect(b).toMatchObject({
        status: 'CONFIRMED',
        confirmed_by: adminId,
        confirmed_at: h.clock.now(),
        settle_mode: 'IMMEDIATE',
      });
    }
    expect(s.vouchers).toEqual(launched.vouchers);
    expect(s.balances).toEqual(launched.balances);
  },
  TIMEOUT,
);
