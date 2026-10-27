// B2-11d BR-WDR-30 开启前置检查 (规划/08 BR-WDR-30 细则「开启前置检查」, 决-09 A): before
// withdraw.auto_payout.enabled goes on, BR-WDR-22 ② (limits), ⑤ (failure codes and query states)
// and ⑧ (daily bill with out_biz_no) must be judged supported in 规划/09, and the daily channel
// reconciliation (BR-WDR-23) must have run through for the number of days the owner set. The
// owner registers each under payout.auto_enable_check.* (kit); an unregistered item does not pass
// (缺省不通过). checkAutoPayoutEnable lists every item in the order ② ⑤ ⑧ days, and passes only
// when all pass; readAutoPayoutEnableCheck reads the same keys through payout's config port.
import { expect, it } from 'vitest';
import { readAutoPayoutEnableCheck } from '../../../../apps/api/src/modules/payout/application/auto-config.ts';
import type { PayoutConfigPort } from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';
import { checkAutoPayoutEnable } from '../../../../apps/api/src/modules/payout/domain/auto-config.ts';
import {
  BILL_SUPPORTED,
  ENABLE_KEYS,
  ITEM_CODES,
  LIMITS_SUPPORTED,
  RECON_PASSED_DAYS,
  RECON_REQUIRED_DAYS,
  STATUS_CODES_SUPPORTED,
  enablePassing,
  expectedCheck,
  type ItemCode,
} from './kit.ts';

function withValue(key: string, value: unknown): Map<string, unknown> {
  const values = enablePassing();
  if (value === undefined) values.delete(key);
  else values.set(key, value);
  return values;
}

it('[AC-B2-11d#11] 缺省不通过：一个键都没登记时四项全部不通过，开启前置检查不通过', () => {
  expect(checkAutoPayoutEnable(new Map())).toStrictEqual(expectedCheck(ITEM_CODES));
});

it('[AC-B2-11d#12] ② ⑤ ⑧ 都判为支持、对账连续跑通天数达到负责人定的天数 → 通过，四项按 ② ⑤ ⑧ 天数顺序列出', () => {
  expect(checkAutoPayoutEnable(enablePassing())).toStrictEqual(expectedCheck([]));
});

const SUPPORT_ITEMS: ReadonlyArray<{ key: string; code: ItemCode }> = [
  { key: LIMITS_SUPPORTED, code: 'limits_supported' },
  { key: STATUS_CODES_SUPPORTED, code: 'status_codes_supported' },
  { key: BILL_SUPPORTED, code: 'bill_out_biz_no_supported' },
];

it.each(
  SUPPORT_ITEMS.flatMap((item) =>
    [undefined, false, 'true', 'on', 1, null].map((value) => ({ ...item, value })),
  ),
)(
  '[AC-B2-11d#13] $key 为 $value（只认 JSON true）→ 只有 $code 不通过，整体不通过',
  ({ key, code, value }) => {
    expect(checkAutoPayoutEnable(withValue(key, value))).toStrictEqual(expectedCheck([code]));
  },
);

it.each([
  { required: 7, passed: 7, ok: true },
  { required: 7, passed: 30, ok: true },
  { required: 1, passed: 1, ok: true },
  { required: 7, passed: 6, ok: false },
  { required: 30, passed: 0, ok: false },
  { required: 0, passed: 0, ok: false },
  { required: 0, passed: 5, ok: false },
  { required: undefined, passed: 30, ok: false },
  { required: 7, passed: undefined, ok: false },
  { required: undefined, passed: undefined, ok: false },
  { required: '7', passed: 7, ok: false },
  { required: 7, passed: '7', ok: false },
  { required: 7, passed: 7.5, ok: false },
  { required: 7, passed: -1, ok: false },
])(
  '[AC-B2-11d#14] 对账天数：负责人定 $required 天、已连续跑通 $passed 天 → recon_days 通过=$ok（天数须由负责人填为正整数）',
  ({ required, passed, ok }) => {
    const values = withValue(RECON_REQUIRED_DAYS, required);
    if (passed === undefined) values.delete(RECON_PASSED_DAYS);
    else values.set(RECON_PASSED_DAYS, passed);
    expect(checkAutoPayoutEnable(values)).toStrictEqual(expectedCheck(ok ? [] : ['recon_days']));
  },
);

it('[AC-B2-11d#15] 几项同时不满足：全部标出，列表仍是四项、顺序不变', () => {
  const values = enablePassing();
  values.set(STATUS_CODES_SUPPORTED, false);
  values.set(RECON_PASSED_DAYS, 2);
  expect(checkAutoPayoutEnable(values)).toStrictEqual(
    expectedCheck(['status_codes_supported', 'recon_days']),
  );
});

/** A config port over `rows`, recording each read. */
function port(rows: ReadonlyMap<string, unknown>) {
  const reads: Array<{ appId: string; key: string; handle: unknown }> = [];
  const config: PayoutConfigPort = {
    configValue(appId, key, handle) {
      reads.push({ appId, key, handle });
      return Promise.resolve(rows.has(key) ? { value: rows.get(key), version: 1 } : null);
    },
  };
  return { config, reads };
}

const HANDLE = {} as Parameters<typeof readAutoPayoutEnableCheck>[1];

it('[AC-B2-11d#16] 读配置口：用调用方的 appId 与 handle 读 payout.auto_enable_check.* 五个键，全部登记且达标 → 通过', async () => {
  const { config, reads } = port(enablePassing());
  await expect(readAutoPayoutEnableCheck('app-1', HANDLE, config)).resolves.toStrictEqual(
    expectedCheck([]),
  );
  expect([...new Set(reads.map((read) => read.key))].sort()).toStrictEqual([...ENABLE_KEYS].sort());
  for (const read of reads) {
    expect(read.appId).toBe('app-1');
    expect(read.handle).toBe(HANDLE);
  }
});

it('[AC-B2-11d#17] 读配置口：库里没有这些行 → 四项全部不通过（缺省不通过）', async () => {
  const { config } = port(new Map());
  await expect(readAutoPayoutEnableCheck('app-1', HANDLE, config)).resolves.toStrictEqual(
    expectedCheck(ITEM_CODES),
  );
});

it('[AC-B2-11d#18] 读配置口：只差对账天数 → 只有 recon_days 不通过', async () => {
  const { config } = port(withValue(RECON_PASSED_DAYS, 3));
  await expect(readAutoPayoutEnableCheck('app-1', HANDLE, config)).resolves.toStrictEqual(
    expectedCheck(['recon_days']),
  );
});
