// 单元测试（不连库）：已有子订单明细何时阻挡该单进入补充批次（评审 r1 S1，BR-FUND-04 迁移表表外）。
import { expect, it } from 'vitest';
import { blocksSupplement, supplementJobRunAt } from './command.ts';

const PAUSED = new Date('2032-07-25T10:00:00+08:00');

it('[AC-B2-04r-UNIT#1] PARTIAL 主批次里仍未处理的明细不阻挡该单进入补充批次', () => {
  expect(
    blocksSupplement({ batchStatus: 'PARTIAL', pausedBySwitchAt: null, itemResult: null }),
  ).toBe(false);
  expect(
    blocksSupplement({ batchStatus: 'PARTIAL', pausedBySwitchAt: PAUSED, itemResult: null }),
  ).toBe(false);
});

it('[AC-B2-04r-UNIT#2] 被开关停住的 CONFIRMED 批次不阻挡；未停住的 CONFIRMED 阻挡', () => {
  expect(
    blocksSupplement({ batchStatus: 'CONFIRMED', pausedBySwitchAt: PAUSED, itemResult: null }),
  ).toBe(false);
  expect(
    blocksSupplement({ batchStatus: 'CONFIRMED', pausedBySwitchAt: null, itemResult: null }),
  ).toBe(true);
});

it('[AC-B2-04r-UNIT#3] DRAFT 与 EXECUTING 中尚未处理的明细阻挡', () => {
  expect(blocksSupplement({ batchStatus: 'DRAFT', pausedBySwitchAt: null, itemResult: null })).toBe(
    true,
  );
  expect(
    blocksSupplement({ batchStatus: 'EXECUTING', pausedBySwitchAt: null, itemResult: null }),
  ).toBe(true);
});

it('[AC-B2-04r-UNIT#4] 已有结果的明细与 DONE / CANCELLED 批次都不阻挡', () => {
  for (const itemResult of ['credited', 'skipped', 'deferred']) {
    expect(blocksSupplement({ batchStatus: 'EXECUTING', pausedBySwitchAt: null, itemResult })).toBe(
      false,
    );
  }
  expect(blocksSupplement({ batchStatus: 'DONE', pausedBySwitchAt: null, itemResult: null })).toBe(
    false,
  );
  expect(
    blocksSupplement({ batchStatus: 'CANCELLED', pausedBySwitchAt: null, itemResult: null }),
  ).toBe(false);
});

// D10-280 ①：补充与账单日任务共用 job = 'bill'，键 (app, job, platform, run_at)。
const BILL_DAY = 24;
/** 账单日任务的 run_at，也是同一时刻发起的补充的名义请求时刻（撞键）。 */
const BILL_DAY_RUN = new Date('2032-07-24T10:00:00+08:00');

it('[AC-B2-04r-UNIT#5] 名义请求时刻撞上账单日任务的 run_at：补充键顺延 1 ms，认领新键照常执行', () => {
  const key = supplementJobRunAt(BILL_DAY_RUN, BILL_DAY);
  expect(key.shifted).toBe(true);
  expect(key.runAt.getTime()).toBe(BILL_DAY_RUN.getTime() + 1);
  // 不再等于账单日任务的键，认领时插入新行而不是撞唯一键被判重放。
  expect(key.runAt.getTime()).not.toBe(BILL_DAY_RUN.getTime());
  // 账单日 00:00（+08:00）整点同样顺延；前一天 23:59:59.999 不是账单日、不顺延。
  const midnight = new Date('2032-07-24T00:00:00+08:00');
  expect(supplementJobRunAt(midnight, BILL_DAY).runAt.getTime()).toBe(midnight.getTime() + 1);
  const eve = new Date('2032-07-23T23:59:59.999+08:00');
  expect(supplementJobRunAt(eve, BILL_DAY)).toEqual({ runAt: eve, shifted: false });
  // 账单日按配置：bill_day = 25 时 24 号不顺延。
  expect(supplementJobRunAt(BILL_DAY_RUN, 25)).toEqual({ runAt: BILL_DAY_RUN, shifted: false });
});

it('[AC-B2-04r-UNIT#6] 同一次补充发起的真重放算出同一个键，撞唯一键照旧 duplicate', () => {
  // 非账单日：键 = 名义请求时刻，账单日任务不会在这天认领键，已有行只可能是本次发起的。
  const launch = new Date('2032-07-26T10:00:00+08:00');
  const first = supplementJobRunAt(launch, BILL_DAY);
  const replay = supplementJobRunAt(new Date(launch.getTime()), BILL_DAY);
  expect(first).toEqual({ runAt: launch, shifted: false });
  expect(replay.runAt.getTime()).toBe(first.runAt.getTime());
  // 账单日：顺延是确定性的（不看当下有没有行），重放落在同一个顺延后的键上，不会再顺延一次。
  const shiftedFirst = supplementJobRunAt(BILL_DAY_RUN, BILL_DAY);
  const shiftedReplay = supplementJobRunAt(new Date(BILL_DAY_RUN.getTime()), BILL_DAY);
  expect(shiftedReplay.runAt.getTime()).toBe(shiftedFirst.runAt.getTime());
  expect(shiftedReplay.runAt.getTime()).toBe(BILL_DAY_RUN.getTime() + 1);
});
