// B1-09b 实现者单元测试：planBlacklistHit 的边界（规则测试在 test/spec/orders/blacklist/**）。
import { expect, it } from 'vitest';
import { planBlacklistHit } from './blacklist.ts';

it('[AC-B1-09b#u3] 同一维度同一值重复命中（名单里两条同值记录）只记一条', () => {
  const plan = planBlacklistHit({
    matches: [
      { dimension: 'channel', value: 'R8' },
      { dimension: 'channel', value: 'R8' },
    ],
    rebate_status: 'ESTIMATED',
    suffix_void_enabled: false,
  });
  expect(plan).toEqual({
    disposition: 'void',
    hits: [{ dimension: 'channel', value: 'R8', risk_action: 'void_commission' }],
  });
});

it('[AC-B1-09b#u4] 六种之外的返利状态不猜处置，抛错', () => {
  expect(() =>
    planBlacklistHit({
      matches: [{ dimension: 'channel', value: 'R8' }],
      rebate_status: 'SOMETHING',
      suffix_void_enabled: false,
    }),
  ).toThrow(/BLACKLIST_REBATE_STATUS_INVALID/);
});

it('[AC-B1-09b#u5] 已入账：渠道命中记 manual_review 并 after_credit', () => {
  expect(
    planBlacklistHit({
      matches: [{ dimension: 'channel', value: 'R8' }],
      rebate_status: 'CREDITED',
      suffix_void_enabled: false,
    }),
  ).toEqual({
    disposition: 'after_credit',
    hits: [{ dimension: 'channel', value: 'R8', risk_action: 'manual_review' }],
  });
});
