// B2-04p rule tests on a real PostgreSQL: executor liveness and SB9. BR-FUND-04 细则 SB9 (an
// EXECUTING batch without a live executor is taken over and resumed from the first unprocessed item;
// committed ones are not credited again) and 例「崩溃续跑」E-18; 规划/12 §4.3 (a duplicate delivery
// while the executor is alive ends without changing the batch; concurrent starts: one wins).
// Every executor below runs on its own pool, i.e. its own PostgreSQL connections (QA-02). A crash is
// the server killing every backend of the executor's pool, never a mocked error alone.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  TIMEOUT,
  creditedOnce,
  databaseFixture,
  deferred,
  fixture,
  nth,
  p0Orders,
  terminate,
  untouched,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-04p#20] 崩溃续跑（E-18）：10 单的批次在第 4 单事务中执行者进程连接全部断开 → 批次停在 EXECUTING、前 3 单已入账；另一执行者按 SB9 从第 4 单续跑，10 单各入账一次：用户合计 4800、平台 5200、UNION_RECEIVABLE 10000',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'crash', 10);
    const b = await f.batch([...orders].reverse());
    const name = `b204p-crash-${randomUUID().slice(0, 8)}`;
    const crashed = p.pool(name);

    const reached = deferred();
    const release = deferred();
    f.onCredit(nth(orders, 3), async () => {
      reached.resolve();
      await release.promise;
      throw new Error('executor process died');
    });
    const first = f.run(b, crashed, 'A');
    const settled = first.then(
      () => 'resolved',
      () => 'rejected',
    );
    try {
      await reached.promise;
      expect(await terminate(p.db, name)).toBeGreaterThan(0);
    } finally {
      release.resolve();
    }
    await settled;

    expect((await f.stored(b)).status).toBe('EXECUTING');
    for (const o of orders.slice(0, 3)) {
      await creditedOnce(f, o);
      expect((await f.itemOf(b, o)).result).toBe('credited');
    }
    for (const o of orders.slice(3)) {
      await untouched(f, o);
      expect((await f.itemOf(b, o)).result).toBeNull();
    }

    expect(await f.run(b, p.pool(), 'B')).toMatchObject({ outcome: 'done' });
    expect(f.creditedBy('B')).toEqual(orders.slice(3).map((o) => o.orderId));
    for (const o of orders) {
      await creditedOnce(f, o);
      expect((await f.itemOf(b, o)).result).toBe('credited');
    }
    expect(await f.h.subjectNet('USER_BALANCE')).toBe(-4800n);
    expect(await f.h.subjectNet('COMMISSION_REVENUE')).toBe(-5200n);
    expect(await f.h.subjectNet('UNION_RECEIVABLE:taobao')).toBe(10000n);
    expect((await f.stored(b)).status).toBe('DONE');
    expect(await f.doneEvents()).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04p#21] 执行者仍存活时的重复投递（另一连接）：立即 busy，不等待、不改批次与明细；原执行者继续执行完，每单只入账一次、一条 settle.batch_done',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'alive', 3);
    const b = await f.batch(orders);
    const reached = deferred();
    const release = deferred();
    f.onCredit(nth(orders, 1), async () => {
      reached.resolve();
      await release.promise;
    });
    const first = f.run(b, p.pool(), 'A');
    void first.catch(() => undefined);
    try {
      await reached.promise;
      const before = await f.snapshot();
      expect(await f.run(b, p.pool(), 'B')).toMatchObject({ outcome: 'busy' });
      expect(await f.snapshot()).toEqual(before);
      expect(f.creditedBy('B')).toEqual([]);
    } finally {
      release.resolve();
    }
    expect(await first).toMatchObject({ outcome: 'done' });
    expect(f.creditedBy('A')).toEqual(orders.map((o) => o.orderId));
    for (const o of orders) await creditedOnce(f, o);
    expect(await f.doneEvents()).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04p#22] 同一 CONFIRMED 批次被两个执行者同时投递（两条连接）：只有一个执行，另一个 busy 或 idle；每单只调用一次入账、只入账一次，一条 settle.batch_done',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'race', 4);
    const b = await f.batch(orders);
    const results = await Promise.all([f.run(b, p.pool(), 'A'), f.run(b, p.pool(), 'B')]);
    const outcomes = results.map((r) => r.outcome);
    expect(outcomes.filter((o) => o === 'done')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'busy' || o === 'idle')).toHaveLength(1);
    for (const o of orders) {
      expect(f.creditCalls.filter((c) => c.input.orderId === o.orderId)).toHaveLength(1);
      await creditedOnce(f, o);
    }
    expect((await f.stored(b)).status).toBe('DONE');
    expect(await f.doneEvents()).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04p#23] 前一天中断、停在 EXECUTING 的批次在当日快照完成前被接管：snapshot_pending，不入账、不改批次；快照完成后 SB9 续跑，不改 started_at',
  async () => {
    const f = await fixture(p.db);
    const orders = await p0Orders(f, 'sb9snap', 2);
    const startedAt = new Date('2032-07-23T23:30:00+08:00');
    const b = await f.batch(orders, {
      status: 'EXECUTING',
      confirmed_at: new Date('2032-07-23T23:00:00+08:00'),
      started_at: startedAt,
    });
    f.clock.set('2032-07-24T00:10:00+08:00');
    const before = await f.snapshot();
    expect(await f.run(b)).toMatchObject({ outcome: 'snapshot_pending' });
    expect(await f.snapshot()).toEqual(before);
    expect(f.creditCalls).toHaveLength(0);

    await f.snapshotDone('2032-07-23');
    expect(await f.run(b)).toMatchObject({ outcome: 'done' });
    expect(await f.stored(b)).toMatchObject({ status: 'DONE', started_at: startedAt });
    for (const o of orders) await creditedOnce(f, o);
  },
  TIMEOUT,
);
