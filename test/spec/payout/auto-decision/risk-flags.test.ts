// B2-11b ⑫ of decideAutoPayout (规划/08 BR-WDR-30 细则 ⑫, BR-WDR-29「与自动到账的衔接」; snapshot
// shape D10-367): every code of the W1 risk_flags snapshot that is in risk_block_flags fails as
// risk_flag:<code>; the real-time blacklist_hit always fails as risk_flag:blacklist_hit, whatever
// the configured set; first_withdrawal, credited_today, invalid_ratio_60d,
// high_commission_ratio_60d and withdraw_vs_received are not blocking by default. Several hits are
// listed in the BR-WDR-29 label order (LABEL_ORDER), whatever the order of the snapshot or the set,
// between ⑪ channel_disabled and ⑬ w2_guard.
import { expect, it } from 'vitest';
import {
  decideAutoPayout,
  type AutoPayoutInput,
  type AutoPayoutRiskFlag,
} from '../../../../apps/api/src/modules/payout/domain/auto-decision.ts';
import { DEFAULT_BLOCK_FLAGS, passing } from './kit.ts';

function flag(code: string): AutoPayoutRiskFlag {
  return { code, value: 1, threshold: null };
}

function failed(value: AutoPayoutInput) {
  return decideAutoPayout(value).failed_conditions;
}

it.each(DEFAULT_BLOCK_FLAGS.map((code) => ({ code })))(
  '[AC-B2-11b#42] ⑫ 快照含默认阻断标签 $code → manual，failed_conditions=[risk_flag:$code]',
  ({ code }) => {
    const value = passing();
    value.risk_flags = [flag(code)];
    expect(decideAutoPayout(value)).toMatchObject({
      result: 'manual',
      failed_conditions: [`risk_flag:${code}`],
    });
  },
);

it.each(
  [
    'first_withdrawal',
    'credited_today',
    'invalid_ratio_60d',
    'high_commission_ratio_60d',
    'withdraw_vs_received',
  ].map((code) => ({ code })),
)('[AC-B2-11b#43] ⑫ $code 默认不在阻断集合：快照含它仍可自动', ({ code }) => {
  const value = passing();
  value.risk_flags = [flag(code)];
  expect(decideAutoPayout(value)).toMatchObject({ result: 'auto', failed_conditions: [] });
});

it('[AC-B2-11b#44] ⑫ 实时 blacklist_hit 固定检查：命中即 risk_flag:blacklist_hit，阻断集合为空也一样', () => {
  const value = passing();
  value.blacklist_hit = true;
  expect(failed(value)).toEqual(['risk_flag:blacklist_hit']);
  value.config.risk_block_flags = [];
  expect(failed(value)).toEqual(['risk_flag:blacklist_hit']);
  value.blacklist_hit = false;
  expect(failed(value)).toEqual([]);
});

it('[AC-B2-11b#45] ⑫ 阻断集合可配置：加入 first_withdrawal 后命中，移出 had_negative 后不再命中', () => {
  const added = passing();
  added.config.risk_block_flags = [...DEFAULT_BLOCK_FLAGS, 'first_withdrawal'];
  added.risk_flags = [flag('first_withdrawal')];
  expect(failed(added)).toEqual(['risk_flag:first_withdrawal']);
  const removed = passing();
  removed.config.risk_block_flags = DEFAULT_BLOCK_FLAGS.filter((code) => code !== 'had_negative');
  removed.risk_flags = [flag('had_negative')];
  expect(failed(removed)).toEqual([]);
});

it('[AC-B2-11b#46] ⑫ 只记快照与集合的交集：集合外的快照标签不记', () => {
  const value = passing();
  value.risk_flags = [flag('first_withdrawal'), flag('recon_diff'), flag('credited_today')];
  expect(failed(value)).toEqual(['risk_flag:recon_diff']);
});

it('[AC-B2-11b#47] ⑫ 多个命中全列，按 BR-WDR-29 标签顺序，与快照、集合的顺序无关', () => {
  const expected = [
    'risk_flag:same_device_multi_account',
    'risk_flag:had_negative',
    'risk_flag:recon_diff',
    'risk_flag:blacklist_hit',
    'risk_flag:payee_prev_other_user',
    'risk_flag:risk_calc_failed',
  ];
  const value = passing();
  value.blacklist_hit = true;
  value.risk_flags = [
    flag('risk_calc_failed'),
    flag('payee_prev_other_user'),
    flag('recon_diff'),
    flag('had_negative'),
    flag('same_device_multi_account'),
  ];
  expect(failed(value)).toEqual(expected);
  value.config.risk_block_flags = [...DEFAULT_BLOCK_FLAGS].reverse();
  value.risk_flags = [...value.risk_flags].reverse();
  expect(failed(value)).toEqual(expected);
});

it('[AC-B2-11b#48] ⑫ 位于 ⑪ channel_disabled 之后、⑬ w2_guard 之前', () => {
  const value = passing();
  value.adult = false;
  value.channel_enabled = false;
  value.w2_guard_passed = false;
  value.blacklist_hit = true;
  value.risk_flags = [flag('recon_diff'), flag('had_negative')];
  expect(failed(value)).toEqual([
    'minor',
    'channel_disabled',
    'risk_flag:had_negative',
    'risk_flag:recon_diff',
    'risk_flag:blacklist_hit',
    'w2_guard',
  ]);
});
