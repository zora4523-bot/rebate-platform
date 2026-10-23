// 单元测试（不连库）：已有子订单明细何时阻挡该单进入补充批次（评审 r1 S1，BR-FUND-04 迁移表表外）。
import { expect, it } from 'vitest';
import { blocksSupplement } from './command.ts';

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
