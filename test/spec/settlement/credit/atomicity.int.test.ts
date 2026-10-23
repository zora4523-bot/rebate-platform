// B2-04m rule tests: one PG transaction for the whole credit (BR-FUND-01: balances and entries only
// in the transaction of the rebate transition; BR-FUND-05: vouchers, balances, booked pair and
// CREDITED together). A failure anywhere rolls everything back; nothing is left half-written.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  databaseFixture,
  failAfter,
  harness,
  ordersCasMisses,
  platformKey,
  type Harness,
  type SeededOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** One frozen direct beneficiary, so obligations and beneficiary events are written too. */
async function seeded(h: Harness): Promise<SeededOrder> {
  return h.order({
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000, state: 'frozen' },
      { role: 'indirect', ratioBp: 500, state: 'banned' },
    ],
  });
}

async function creditsOnceAfterwards(h: Harness, o: SeededOrder): Promise<void> {
  expect(await h.credit(o)).toMatchObject({ outcome: 'credited' });
  expect(await h.read(o)).toMatchObject({ rebate_status: 'CREDITED', booked_base_fen: 850n });
  expect(await h.balance(o.user('self'))).toBe(425n);
  expect(await h.obligations()).toHaveLength(1);
  expect((await h.published()).map((e) => e.name)).toEqual(['order.credited']);
}

it(
  '[AC-B2-04m#21] order.credited 入队写后抛错：凭证、余额、义务、受益人事件、订单列、历史全部回滚；恢复后重跑只入一次',
  async () => {
    const h = await harness(p.db);
    const o = await seeded(h);
    const before = await h.state();
    h.boot();
    const write = h.publish.getMockImplementation();
    if (write === undefined) throw new Error('publish has no implementation');
    const failure = new Error('synthetic enqueue failure');
    h.publish.mockImplementation(async (trx, event) => {
      await write(trx, event);
      throw failure;
    });
    await expect(h.credit(o)).rejects.toBe(failure);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalled();
    expect(await h.state()).toEqual(before);

    h.publish.mockImplementation(write);
    await creditsOnceAfterwards(h, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#22] first_credit 义务写入后数据库层失败：整事务回滚，不留已入账的余额或凭证',
  async () => {
    const h = await harness(p.db);
    const o = await seeded(h);
    const before = await h.state();
    h.boot();
    const faulty = failAfter(p.db, (q) =>
      /^insert\s+into\s+(?:"?app"?\.)?"?beneficiary_credits"?\s/i.test(q.sql),
    );
    await expect(h.credit(o, { via: faulty.db })).rejects.toThrow('injected failure');
    expect(faulty.injected()).toBe(1);
    expect(await h.state()).toEqual(before);
    await creditsOnceAfterwards(h, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#23] 平台凭证写入后数据库层失败：先写的受益人凭证与余额一起回滚',
  async () => {
    const h = await harness(p.db);
    const o = await seeded(h);
    const before = await h.state();
    h.boot();
    const key = platformKey(o);
    const faulty = failAfter(
      p.db,
      (q) =>
        /^insert\s+into\s+(?:"?app"?\.)?"?ledger_vouchers"?\s/i.test(q.sql) &&
        q.parameters.includes(key),
    );
    await expect(h.credit(o, { via: faulty.db })).rejects.toThrow('injected failure');
    expect(faulty.injected()).toBe(1);
    expect(await h.state()).toEqual(before);
    await creditsOnceAfterwards(h, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#24] 订单 CAS 一直命中 0 行：不当成功，抛错并整事务回滚（凭证、余额、义务都不留）',
  async () => {
    const h = await harness(p.db);
    const o = await seeded(h);
    const before = await h.state();
    h.boot();
    const conflicted = ordersCasMisses(p.db);
    await expect(h.credit(o, { via: conflicted.db })).rejects.toThrow();
    expect(conflicted.misses()).toBeGreaterThan(0);
    expect(await h.state()).toEqual(before);
    expect(h.publish).not.toHaveBeenCalled();
    await creditsOnceAfterwards(h, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#25] 入账只用调用方的事务：调用方在入账成功后抛错，全部回滚（服务不私开 / 提交事务）',
  async () => {
    const h = await harness(p.db);
    const o = await seeded(h);
    const before = await h.state();
    const service = h.boot();
    const failure = new Error('synthetic caller failure');
    const seen: string[] = [];
    await expect(
      p.db.transaction().execute(async (trx) => {
        const result = await service.credit(trx, h.input(o));
        seen.push(result.outcome);
        const row = await trx
          .selectFrom('orders')
          .select('rebate_status')
          .where('app_id', '=', h.appId)
          .where('order_id', '=', o.orderId)
          .executeTakeFirstOrThrow();
        seen.push(row.rebate_status);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(seen).toEqual(['credited', 'CREDITED']);
    expect(await h.state()).toEqual(before);
    await creditsOnceAfterwards(h, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04m#26] 快照缺失：抛错且什么都不写（不按空快照把整单归平台）',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const before = await h.state();
    h.boot();
    h.readSnapshot.mockResolvedValue(null);
    await expect(h.credit(o)).rejects.toThrow();
    expect(await h.state()).toEqual(before);
  },
  TIMEOUT,
);
