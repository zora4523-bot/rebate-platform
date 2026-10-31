// B2-04zg: the catch-up seed of the monthly bill (D10-476 / task brief §9.2; 08 BR-FUND-04 ③). For
// every app (distinct app_id of app.orders) × platform it looks back at the latest bill day D* on
// or before the +08:00 day of the injected Clock (settle.bill_day of the app, unset = 24) and sends
// D*'s `bill` job — the daily seed's payload and singletonKey, outside a transaction — unless the
// store says the bill month M is generated or a job is live. Only D* is ever asked about or sent:
// earlier periods are not looked at. The store here is a synthetic one; the apps come from the test
// database.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { seedSettleBillCatchUp } from '../../../../apps/api/src/modules/settlement/worker/index.ts';
import {
  APP,
  BILL_DAY,
  BILL_DAY_NOW,
  JD,
  OTHER,
  PDD,
  TAOBAO,
  THIRD,
  TIMEOUT,
  billKey,
  byKey,
  fakeQueue,
  memoryLogger,
  refusal,
  seedKey,
  seedOrder,
  withDatabase,
} from '../worker/kit.ts';
import {
  DAY_AFTER_NOW,
  NEXT_BILL_DAY,
  PREV_BILL_DAY,
  fakeCatchUpStore,
  fakeConfig,
  outsideAndSoon,
  plainBillSend,
  plainView,
  sendShapes,
} from './kit.ts';

it(
  '[AC-B2-04zg#3] 补出账回看最近一个已到账单日 D*：账单日整日停机后的次日、到下个账单日前一刻、账单日当天，都给每个有订单的 app × 每个平台送 D* 的 bill（负载与 singletonKey 同当日补种，事务外、立即或数分钟内）；账单日前一天回看上月账单日；跨过下个账单日零点即换成新一期',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await seedOrder(db, APP, TAOBAO);
      await seedOrder(db, APP, TAOBAO);
      await seedOrder(db, OTHER, JD);
      // Only an order key (no orders row): not an app of the catch-up.
      await seedKey(db, THIRD, TAOBAO);
      const platforms = [TAOBAO, JD, PDD];
      const { logger } = memoryLogger();
      const cases: [string, string][] = [
        [DAY_AFTER_NOW, BILL_DAY],
        // 2032-08-24 00:00 +08:00 minus 1 ms: still the 07-24 period.
        ['2032-08-23T15:59:59.999Z', BILL_DAY],
        [BILL_DAY_NOW, BILL_DAY],
        // 2032-07-23 23:59:59.999 +08:00: the 06-24 period.
        ['2032-07-23T15:59:59.999Z', PREV_BILL_DAY],
        // 2032-08-24 00:00 +08:00: the next period.
        ['2032-08-23T16:00:00.000Z', NEXT_BILL_DAY],
      ];
      for (const [now, day] of cases) {
        const queue = fakeQueue();
        await seedSettleBillCatchUp({
          db,
          clock: new FixedClock(now),
          queue,
          logger,
          runs: fakeCatchUpStore(),
          platforms,
          config: fakeConfig(new Map()),
        });
        expect(byKey(queue.sent.map(plainView)), now).toStrictEqual(
          byKey([APP, OTHER].flatMap((app) => platforms.map((p) => plainBillSend(app, p, day)))),
        );
        expect(sendShapes(queue.sent), now).toStrictEqual(outsideAndSoon(6));
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zg#4] 更早期次不追溯：账单月 2032-06（07-24）与 2032-05（06-24）都未生成时，次日与下月初的补出账只问、只送 07-24 这一期，06-24 不问不送',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await seedOrder(db, APP, TAOBAO);
      const { logger } = memoryLogger();
      for (const now of [DAY_AFTER_NOW, '2032-08-05T02:00:00.000Z']) {
        const runs = fakeCatchUpStore();
        const queue = fakeQueue();
        await seedSettleBillCatchUp({
          db,
          clock: new FixedClock(now),
          queue,
          logger,
          runs,
          platforms: [TAOBAO, JD],
          config: fakeConfig(new Map()),
        });
        expect([...new Set(runs.reads)].sort(), now).toStrictEqual(
          [billKey(APP, TAOBAO, BILL_DAY), billKey(APP, JD, BILL_DAY)].sort(),
        );
        expect(byKey(queue.sent.map(plainView)), now).toStrictEqual(
          byKey([plainBillSend(APP, TAOBAO, BILL_DAY), plainBillSend(APP, JD, BILL_DAY)]),
        );
        const keys = queue.sent.map((job) => job.options.singletonKey);
        expect(keys).not.toContain(billKey(APP, TAOBAO, PREV_BILL_DAY));
        expect(keys).not.toContain(billKey(APP, JD, PREV_BILL_DAY));
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zg#5] 补出账按库内状态取舍：账单月已生成（generated）或已有排队 / 执行中任务（pending）不送，absent 才送；连续两轮（新的存储与调用，即重启后）判定相同，已生成的一期不会再送',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await seedOrder(db, APP, TAOBAO);
      await seedOrder(db, OTHER, TAOBAO);
      const states = [
        [billKey(APP, TAOBAO, BILL_DAY), 'generated'],
        [billKey(APP, JD, BILL_DAY), 'pending'],
        [billKey(OTHER, TAOBAO, BILL_DAY), 'absent'],
      ] as const;
      const { logger } = memoryLogger();
      const clock = new FixedClock(DAY_AFTER_NOW);
      for (let round = 0; round < 2; round += 1) {
        const runs = fakeCatchUpStore();
        for (const [key, state] of states) runs.states.set(key, state);
        const queue = fakeQueue();
        await seedSettleBillCatchUp({
          db,
          clock,
          queue,
          logger,
          runs,
          platforms: [TAOBAO, JD],
          config: fakeConfig(new Map()),
        });
        expect(byKey(queue.sent.map(plainView)), `round ${String(round)}`).toStrictEqual(
          byKey([plainBillSend(OTHER, TAOBAO, BILL_DAY), plainBillSend(OTHER, JD, BILL_DAY)]),
        );
        expect([...new Set(runs.reads)].sort()).toStrictEqual(
          [
            billKey(APP, TAOBAO, BILL_DAY),
            billKey(APP, JD, BILL_DAY),
            billKey(OTHER, TAOBAO, BILL_DAY),
            billKey(OTHER, JD, BILL_DAY),
          ].sort(),
        );
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zg#6] 回看用各 app 自己的 settle.bill_day（未设按 24）：设 26 的 app 在 07-25 回看 06-26；某 app 的 settle.bill_day 非法（30）只让该 app 失败，其余照送，失败在全部试完后抛出',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await seedOrder(db, APP, TAOBAO);
      await seedOrder(db, OTHER, TAOBAO);
      await seedOrder(db, THIRD, TAOBAO);
      const { logger } = memoryLogger();
      const config = fakeConfig(
        new Map<string, unknown>([
          [`${APP}|settle.bill_day`, 26],
          [`${THIRD}|settle.bill_day`, 30],
        ]),
      );
      const queue = fakeQueue();
      const text = await refusal(() =>
        seedSettleBillCatchUp({
          db,
          clock: new FixedClock(DAY_AFTER_NOW),
          queue,
          logger,
          runs: fakeCatchUpStore(),
          platforms: [TAOBAO],
          config,
        }),
      );
      expect(text).toMatch(/bill_day/u);
      expect(byKey(queue.sent.map(plainView))).toStrictEqual(
        byKey([plainBillSend(APP, TAOBAO, '2032-06-26'), plainBillSend(OTHER, TAOBAO, BILL_DAY)]),
      );
      expect(queue.sent.map((job) => job.payload['app_id'])).not.toContain(THIRD);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zg#7] 一个 app 送失败不挡其他 app：其余照送，失败在全部试完后抛出；下一轮补出账再送',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await seedOrder(db, APP, TAOBAO);
      await seedOrder(db, OTHER, TAOBAO);
      await seedOrder(db, THIRD, TAOBAO);
      const { logger } = memoryLogger();
      const clock = new FixedClock(DAY_AFTER_NOW);
      const queue = fakeQueue();
      queue.failing.add(OTHER);
      const text = await refusal(() =>
        seedSettleBillCatchUp({
          db,
          clock,
          queue,
          logger,
          runs: fakeCatchUpStore(),
          platforms: [TAOBAO],
          config: fakeConfig(new Map()),
        }),
      );
      expect(text).toContain('synthetic send failure');
      expect(byKey(queue.sent.map(plainView))).toStrictEqual(
        byKey([plainBillSend(APP, TAOBAO, BILL_DAY), plainBillSend(THIRD, TAOBAO, BILL_DAY)]),
      );

      const again = fakeQueue();
      await seedSettleBillCatchUp({
        db,
        clock,
        queue: again,
        logger,
        runs: fakeCatchUpStore(),
        platforms: [TAOBAO],
        config: fakeConfig(new Map()),
      });
      expect(again.sent.map(plainView)).toContainEqual(plainBillSend(OTHER, TAOBAO, BILL_DAY));
    });
  },
  TIMEOUT,
);
