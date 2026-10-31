// B1-05r: when a refresh round runs (BR-PRICE-11 pool.refresh_interval_sec, F-ADM-10). A round is due
// every interval; within one a tick asks the union nothing, also for a key that failed, which waits
// for the next round. The clock starts on a whole hour (kit REFRESH_NOW), so the cases hold for a
// round cut at slot boundaries and for one counted from the last run alike.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { seedPoolRefresh } from '../../../../apps/api/src/modules/catalog/worker/pool-refresh.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  QUEUE,
  REFRESH_KEY,
  REFRESH_SEC,
  TIMEOUT,
  queuedJobs,
  refreshCase,
  secondsAgo,
  type RefreshCase,
} from './kit.ts';

const DUE_SEC = 4000;
const unavailable = (): UnionError =>
  new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao');

/** One due row with its reference, answered by the union. */
async function oneRow(f: RefreshCase) {
  const stable = f.stableOf();
  const pool = await f.pool();
  await f.item(pool, stable, { quoted_at: secondsAgo(f.clock, DUE_SEC) });
  await f.ref(stable);
  f.unionAnswers(stable);
  return { stable, pool };
}

it(
  '[BR-PRICE-11] 未配置按 3600 秒一轮：到点前的 tick 不问联盟，到点再问一次',
  async () => {
    await refreshCase(createTestDatabase, async (f) => {
      await oneRow(f);

      await f.round();
      expect(f.asked).toHaveLength(1);

      f.clock.advanceMs(60_000);
      await f.round();
      f.clock.advanceMs((REFRESH_SEC - 61) * 1000);
      await f.round();
      expect(f.asked).toHaveLength(1);

      f.clock.advanceMs(1000);
      await f.round();
      expect(f.asked).toHaveLength(2);
    });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] pool.refresh_interval_sec 取配置：调成 100 秒后 99 秒不问，100 秒问',
  async () => {
    await refreshCase(createTestDatabase, async (f) => {
      f.settings.set(REFRESH_KEY, 100);
      await oneRow(f);

      await f.round();
      expect(f.asked).toHaveLength(1);

      f.clock.advanceMs(99_000);
      await f.round();
      expect(f.asked).toHaveLength(1);

      f.clock.advanceMs(1000);
      await f.round();
      expect(f.asked).toHaveLength(2);
    });
  },
  TIMEOUT,
);

it(
  '[BR-PROD-05] 暂时失败不在这一轮里重问，下一轮才再试，成功后写入',
  async () => {
    await refreshCase(createTestDatabase, async (f) => {
      const { stable, pool } = await oneRow(f);
      f.unionFails(stable, unavailable());

      await f.round();
      expect(f.asked).toHaveLength(1);

      f.clock.advanceMs(60_000);
      await f.round();
      expect(f.asked).toHaveLength(1);

      f.unionAnswers(stable);
      f.clock.advanceMs((REFRESH_SEC - 60) * 1000);
      await f.round();

      expect(f.asked).toHaveLength(2);
      expect(await f.row(pool, stable)).toMatchObject({
        final_price_fen: 5000n,
        quoted_at: f.clock.now(),
      });
    });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 价格异常、引用失效的行同样等下一轮：quoted_at 没动也不会每个 tick 都问',
  async () => {
    await refreshCase(createTestDatabase, async (f) => {
      const anomalous = await oneRow(f);
      const expired = await oneRow(f);
      f.unionAnswers(anomalous.stable, { price_status: 'anomaly' });
      f.unionFails(
        expired.stable,
        new UnionError('upstream_rejected', 'synthetic refusal', 'taobao'),
      );

      await f.round();
      expect(f.asked).toHaveLength(2);

      f.clock.advanceMs(60_000);
      await f.round();

      expect(f.asked).toHaveLength(2);
    });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 任务排着还没跑时再 tick 不重复：同一轮每个 key 只问一次，任务都带 id',
  async () => {
    await refreshCase(createTestDatabase, async (f) => {
      await oneRow(f);

      await seedPoolRefresh(f.options);
      const queued = (await queuedJobs(f.db)).length;
      await seedPoolRefresh(f.options);

      expect(queued).toBeGreaterThan(0);
      expect(await queuedJobs(f.db)).toHaveLength(queued);
      await f.drain();
      expect(f.asked).toHaveLength(1);
      const sends = f.queue.sent.filter((job) => job.queue === QUEUE);
      expect(sends.length).toBeGreaterThan(0);
      for (const job of sends) expect(job.options.id).toEqual(expect.any(String));
    });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 任务正在跑时再 tick 不重复：不新发任务，同一轮每个 key 只问一次',
  async () => {
    await refreshCase(createTestDatabase, async (f) => {
      await oneRow(f);
      await oneRow(f);
      const ask = f.getItem.getMockImplementation()!;
      const added: number[] = [];
      // The tick lands while the job asking the union is active, the state drainJobs alone never
      // shows a tick: with one job per key the other job is then queued or already completed.
      f.getItem.mockImplementation(async (ref, ctx) => {
        const queued = (await queuedJobs(f.db)).length;
        await seedPoolRefresh(f.options);
        added.push((await queuedJobs(f.db)).length - queued);
        return ask(ref, ctx);
      });

      await f.round();

      expect(added).toEqual([0, 0]);
      expect(f.asked).toHaveLength(2);
      expect(new Set(f.asked).size).toBe(2);
    });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 每个有 online 行的 App 各问各的：同一个 key 两个 App 各问一次，用各自的原串',
  async () => {
    await refreshCase(createTestDatabase, async (f) => {
      const { stable, pool } = await oneRow(f);
      const other = await f.other();
      const foreign = await f.pool(other);
      await f.item(foreign, stable, { quoted_at: secondsAgo(f.clock, DUE_SEC) }, other);
      await f.ref(stable, other, { raw_item_id: `rawOther-${stable}` });
      f.answers.set(`rawOther-${stable}`, () =>
        f.answer(stable, { coupon_fen: 2000n, final_price_fen: 4000n }),
      );

      await f.round();

      expect([...f.asked].sort()).toEqual([`rawOther-${stable}`, `rawRef-${stable}`].sort());
      expect(f.contexts.map((context) => context.appId).sort()).toEqual(
        [f.owner.appId, other.appId].sort(),
      );
      expect(await f.row(pool, stable)).toMatchObject({ final_price_fen: 5000n });
      expect(await f.row(foreign, stable, other)).toMatchObject({ final_price_fen: 4000n });
    });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 只有下线行的 key 不问联盟；online 行不看窗口，未开始的也刷新',
  async () => {
    await refreshCase(createTestDatabase, async (f) => {
      const parked = f.stableOf();
      const upcoming = f.stableOf();
      const pool = await f.pool();
      const aged = secondsAgo(f.clock, DUE_SEC);
      await f.item(pool, parked, { quoted_at: aged, status: 'offline' });
      await f.item(pool, upcoming, {
        quoted_at: aged,
        start_at: new Date(f.clock.now().getTime() + 3_600_000),
      });
      await f.ref(parked);
      await f.ref(upcoming);
      f.unionAnswers(parked);
      f.unionAnswers(upcoming);

      await f.round();

      expect(f.asked).toEqual([`rawRef-${upcoming}`]);
      expect(await f.row(pool, upcoming)).toMatchObject({ final_price_fen: 5000n });
    });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 库里没有 online 行时一轮什么都不发',
  async () => {
    await refreshCase(createTestDatabase, async (f) => {
      await f.round();

      expect(f.asked).toEqual([]);
      expect(f.queue.sent).toEqual([]);
    });
  },
  TIMEOUT,
);
