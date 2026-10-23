import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Updateable } from 'kysely';
import { expect, it } from 'vitest';
import type { Order } from '../bill/kit.ts';
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
  validations,
  TIMEOUT,
  type Fixture,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

// BR-FUND-04 结算批次迁移表表外：一个 WAITING 子订单可以出现在多个批次的明细里，每个批次执行时
// 逐单重验（⑦），已入账的记 skipped；停在 PARTIAL 的批次不妨碍它进入后续批次。SB4：驳回后批内
// 订单保持 WAITING。下面只改批次 / 明细行模拟执行器（B2-04p）留下的状态，不入账。

/** 首批执行器开始执行的时刻（账单日之后、发起补充之前）。 */
const STARTED = '2032-07-25T10:00:00+08:00';
/** 第二轮补充的名义请求时刻（非账单日）。 */
const NEXT = '2032-07-26T11:00:00+08:00';

async function admin(h: Fixture) {
  const id = randomUUID();
  await h.db
    .withSchema('app')
    .insertInto('admin_users')
    .values({
      id,
      app_id: h.appId,
      login_name: id,
      password_hash: 'test-only',
      is_super: true,
      status: 'active',
    })
    .execute();
  return id;
}

async function setBatch(h: Fixture, batchId: string, patch: Updateable<DB['settle_batches']>) {
  await h.db
    .withSchema('app')
    .updateTable('settle_batches')
    .set(patch)
    .where('app_id', '=', h.appId)
    .where('batch_id', '=', batchId)
    .execute();
}

async function setItem(
  h: Fixture,
  batchId: string,
  o: Order,
  patch: Updateable<DB['settle_batch_items']>,
) {
  await h.db
    .withSchema('app')
    .updateTable('settle_batch_items')
    .set(patch)
    .where('app_id', '=', h.appId)
    .where('batch_id', '=', batchId)
    .where('order_id', '=', o.id)
    .execute();
}

function orderRows(items: readonly { readonly item_type: string; readonly order_id: string }[]) {
  return items
    .filter((i) => i.item_type === 'order')
    .map((i) => i.order_id)
    .sort();
}

it.each([
  { label: 'PARTIAL（SB7 执行中关开关，前一单已入账）', status: 'PARTIAL', processed: true },
  { label: 'CONFIRMED 带开关停住标记（SB5 未开始）', status: 'CONFIRMED', processed: false },
] as const)(
  '[AC-B2-04r#30] 子订单停在 $label 的主批次里仍可进补充批次；两条明细同 seq 同 B_settle，生成不入账，主批续跑入账后不再入批',
  async ({ status, processed }) => {
    const h = fixture(database.db);
    const done = await order(h);
    const left = await order(h);
    for (const o of [done, left]) await settlement(h, o);
    await main(h);
    const [mainBatch] = mains(await state(h));
    const adminId = await admin(h);
    await setBatch(h, mainBatch!.batch_id, {
      status,
      confirmed_by: adminId,
      confirmed_at: new Date(STARTED),
      started_at: status === 'PARTIAL' ? new Date(STARTED) : null,
      paused_by_switch_at: status === 'CONFIRMED' ? new Date(STARTED) : null,
    });
    if (processed) {
      // 关开关前已处理第一单：明细记 credited，订单已 CREDITED（无未完成义务，不生成补记项）。
      await setItem(h, mainBatch!.batch_id, done, { result: 'credited' });
      done.fact.order.rebateStatus = 'CREDITED';
    }
    const before = await state(h);
    const mainLeft = itemsOf(before, mains(before)).find((i) => i.order_id === left.id);
    expect(mainLeft).toMatchObject({ item_type: 'order', result: null });

    const result = await h.launch();
    expect(result).toMatchObject({ outcome: 'generated' });
    const s = await state(h);
    // 主批次与其明细原样保留（续跑由主批次自己负责）；补充轮另起批次纳入同一未处理子订单。
    expect(mains(s)).toEqual(mains(before));
    expect(itemsOf(s, mains(s))).toEqual(itemsOf(before, mains(before)));
    const round1 = supplements(s);
    expect(round1).toEqual([
      expect.objectContaining({ kind: 'supplement', status: 'DRAFT', confirmed_at: null }),
    ]);
    expect([...result.batchIds]).toEqual(round1.map((b) => b.batch_id));
    const supItems = itemsOf(s, round1);
    expect(orderRows(supItems)).toEqual(processed ? [left.id] : [done.id, left.id].sort());
    // ⑦ 锁内重验比对的事实两边一致：同一 settle_seq、同一 B_settle；执行器据此与凭证 uniq_key 只入账一次。
    expect(supItems).toContainEqual(
      expect.objectContaining({
        item_type: 'order',
        order_id: left.id,
        settle_seq: mainLeft!.settle_seq,
        b_settle_fen: mainLeft!.b_settle_fen,
        amount_fen: null,
        result: null,
      }),
    );
    expect(s.vouchers).toEqual(before.vouchers);
    expect(s.balances).toEqual(before.balances);
    expect(s.diffs).toEqual(before.diffs);

    // 主批次续跑（SB8 / SB10）把余下子订单入账；再发起一轮补充，已入账的不再作为子订单行入批。
    for (const o of [done, left]) {
      await setItem(h, mainBatch!.batch_id, o, { result: 'credited' });
      o.fact.order.rebateStatus = 'CREDITED';
    }
    await setBatch(h, mainBatch!.batch_id, {
      status: 'DONE',
      started_at: new Date(STARTED),
      finished_at: new Date(STARTED),
    });
    h.clock.set(NEXT);
    const credited = await state(h);

    const second = await h.launch({ requestedAt: new Date(NEXT) });
    expect(second).toMatchObject({ outcome: 'generated', batchIds: [] });
    const after = await state(h);
    expect(after.batches).toEqual(credited.batches);
    expect(after.items).toEqual(credited.items);
    expect(after.vouchers).toEqual(credited.vouchers);
    expect(after.balances).toEqual(credited.balances);
    const nextRun = new Date(NEXT).toISOString();
    const round2 = (await validations(h)).filter((v) => v.runAt === nextRun);
    const seen = round2.map((v) => [v.orderKey, v.result]).sort();
    expect(seen).toEqual(
      [
        [done.key, 'already_credited'],
        [left.key, 'already_credited'],
      ].sort(),
    );
  },
  TIMEOUT,
);

it.each([
  { label: '主批次被驳回（SB4，CANCELLED）', status: 'CANCELLED', skipped: false },
  { label: '该单在已完成主批次里被跳过（DONE）', status: 'DONE', skipped: true },
  { label: '该单在执行中主批次里已被跳过（EXECUTING）', status: 'EXECUTING', skipped: true },
] as const)(
  '[AC-B2-04r#31] $label 后再发起补充，该 WAITING 子订单可以再入批',
  async ({ status, skipped }) => {
    const h = fixture(database.db);
    const o = await order(h);
    await settlement(h, o);
    // 执行中批次另有一单尚未处理，批次因此仍是 EXECUTING（SB6 之前）；本用例不对它下结论。
    const busy = status === 'EXECUTING' ? await order(h) : null;
    if (busy !== null) await settlement(h, busy);
    await main(h);
    const [mainBatch] = mains(await state(h));
    if (status === 'CANCELLED') {
      await setBatch(h, mainBatch!.batch_id, { status, cancelled_reason: '财务驳回' });
    } else {
      await setBatch(h, mainBatch!.batch_id, {
        status,
        confirmed_by: await admin(h),
        confirmed_at: new Date(STARTED),
        started_at: new Date(STARTED),
        finished_at: status === 'DONE' ? new Date(STARTED) : null,
      });
    }
    if (skipped) {
      // 执行时 ⑦ 重验未通过（例如当时 hold），明细记 skipped；hold 已解除，订单仍 WAITING。
      // skip_reason 取值由执行器定，这里只放一个非空占位。
      await setItem(h, mainBatch!.batch_id, o, { result: 'skipped', skip_reason: 'hold' });
    }
    const before = await state(h);

    const result = await h.launch();
    expect(result).toMatchObject({ outcome: 'generated' });
    expect(result.batchIds.length).toBeGreaterThan(0);
    const s = await state(h);
    expect(mains(s)).toEqual(mains(before));
    expect(itemsOf(s, mains(s))).toEqual(itemsOf(before, mains(before)));
    const supItems = itemsOf(s, supplements(s));
    expect(supItems.filter((i) => i.order_id === o.id)).toEqual([
      expect.objectContaining({
        item_type: 'order',
        settle_seq: 1,
        b_settle_fen: 850n,
        amount_fen: null,
        result: null,
        skip_reason: null,
      }),
    ]);
    const drafts = supplements(s);
    expect(drafts.every((b) => b.status === 'DRAFT' && b.confirmed_at === null)).toBe(true);
    expect(await validations(h)).toContainEqual(
      expect.objectContaining({ orderKey: o.key, result: 'candidate', settleSeq: 1 }),
    );
    expect(s.vouchers).toEqual(before.vouchers);
    expect(s.balances).toEqual(before.balances);
    expect(s.diffs).toEqual(before.diffs);
  },
  TIMEOUT,
);
