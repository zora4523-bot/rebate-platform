// Unit tests of the BR-WDR-30 save check as one write sees it (autoPayoutWriteRefusals) and of its
// defaults staying the readers' defaults. The rule values themselves are the rule tests'
// (test/spec/payout/auto-config).
import { expect, it } from 'vitest';
import {
  AUTO_PAYOUT_SAVE_DEFAULTS,
  AUTO_PAYOUT_SAVE_KEYS,
  autoPayoutWriteRefusals,
} from '../domain/auto-config.ts';
import { AUTO_PAYOUT_DEFAULTS } from './auto-payout.ts';
import { defaultPayoutChannelConfig } from './judgement.ts';
import { DEFAULT_WITHDRAW_LIMITS } from './withdraw-rules.ts';

const MAX = 'withdraw.auto_payout.max_amount_fen';
const WITHDRAW_MAX = 'withdraw.max_amount_fen';
const WINDOW_START = 'withdraw.auto_payout.window_start';
const WINDOW_END = 'withdraw.auto_payout.window_end';
const PLATFORM_MAX = 'withdraw.auto_payout.platform_daily_max_fen';
const DAILY_CAP = 'payout.daily_cap_fen';
const BLOCK_FLAGS = 'withdraw.auto_payout.risk_block_flags';

it('[AC-B2-11d-UNIT#1] 保存校验的缺省值与各读取方的缺省值一致', () => {
  const d = AUTO_PAYOUT_DEFAULTS;
  expect(Object.fromEntries(AUTO_PAYOUT_SAVE_DEFAULTS)).toStrictEqual({
    [MAX]: Number(d.max_amount_fen),
    [WITHDRAW_MAX]: Number(DEFAULT_WITHDRAW_LIMITS.max_amount_fen),
    [WINDOW_START]: d.window_start,
    [WINDOW_END]: d.window_end,
    [PLATFORM_MAX]: Number(d.platform_daily_max_fen),
    [DAILY_CAP]: defaultPayoutChannelConfig().dailyCapFen,
    [BLOCK_FLAGS]: [...d.risk_block_flags],
  });
  expect([...AUTO_PAYOUT_SAVE_KEYS].sort()).toStrictEqual(
    [...AUTO_PAYOUT_SAVE_DEFAULTS.keys()].sort(),
  );
});

it('[AC-B2-11d-UNIT#2] 一次写入：被拒键写了就报它，否则报这次写的、参与比较的另一个键', () => {
  const stored = new Map<string, unknown>([[PLATFORM_MAX, 300000]]);
  expect(autoPayoutWriteRefusals(stored, new Map([[DAILY_CAP, 299999]]))).toStrictEqual([
    DAILY_CAP,
  ]);
  expect(autoPayoutWriteRefusals(stored, new Map([[DAILY_CAP, 300000]]))).toStrictEqual([]);
  expect(
    autoPayoutWriteRefusals(
      stored,
      new Map<string, unknown>([
        [DAILY_CAP, 100],
        [PLATFORM_MAX, 101],
      ]),
    ),
  ).toStrictEqual([PLATFORM_MAX]);
  expect(
    autoPayoutWriteRefusals(
      new Map([[WINDOW_END, '10:59:59']]),
      new Map([[WINDOW_START, '11:00:00']]),
    ),
  ).toStrictEqual([WINDOW_START]);
  expect(autoPayoutWriteRefusals(new Map(), new Map([[WITHDRAW_MAX, 29999]]))).toStrictEqual([
    WITHDRAW_MAX,
  ]);
});

it('[AC-B2-11d-UNIT#3] 违规与本次写入的键无关时不拒这次写入', () => {
  const stored = new Map<string, unknown>([
    [PLATFORM_MAX, 300000],
    [DAILY_CAP, 100],
  ]);
  expect(autoPayoutWriteRefusals(stored, new Map([[MAX, 1000]]))).toStrictEqual([]);
  expect(autoPayoutWriteRefusals(stored, new Map([['withdraw.enabled', true]]))).toStrictEqual([]);
});

it('[AC-B2-11d-UNIT#4] 金额不是整数分时按不满足处理（fail-closed）', () => {
  expect(autoPayoutWriteRefusals(new Map(), new Map([[MAX, '100']]))).toStrictEqual([MAX]);
  expect(autoPayoutWriteRefusals(new Map(), new Map([[DAILY_CAP, 1.5]]))).toStrictEqual([
    DAILY_CAP,
  ]);
});
