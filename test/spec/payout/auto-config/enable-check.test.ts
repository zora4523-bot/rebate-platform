// B2-11d BR-WDR-30 开启前置检查 (规划/08 BR-WDR-30 细则「开启前置检查」, 决-09 A; 编排裁定 D10-392):
// before withdraw.auto_payout.enabled goes on, BR-WDR-22 ② (limits), ⑤ (failure codes and query
// states) and ⑧ (daily bill with out_biz_no) must be judged supported in 规划/09 — three boolean
// keys the owner fills, only JSON true passes — and the daily channel reconciliation (BR-WDR-23)
// must have run through for at least the days the owner set (recon_required_days, an integer
// ≥ 1; unset does not pass). The days run through are a fact: checkAutoPayoutEnable takes them as
// an argument, readAutoPayoutEnableCheck reads them through the reconciliation port (never a
// configuration key), and the default port answers 0 until BR-WDR-23 lands (fail-closed).
import { expect, it } from 'vitest';
import {
  createDefaultReconPassedDays,
  readAutoPayoutEnableCheck,
  type ReconPassedDaysPort,
} from '../../../../apps/api/src/modules/payout/application/auto-config.ts';
import type { PayoutConfigPort } from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';
import { checkAutoPayoutEnable } from '../../../../apps/api/src/modules/payout/domain/auto-config.ts';
import {
  BILL_SUPPORTED,
  ENABLE_KEYS,
  ITEM_CODES,
  LIMITS_SUPPORTED,
  RECON_REQUIRED_DAYS,
  RETIRED_PASSED_DAYS,
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

it('[AC-B2-11d#11] 缺省不通过：一个键都没填时四项全部不通过；对账已跑通 30 天也一样（天数未定）', () => {
  expect(checkAutoPayoutEnable(new Map(), 0)).toStrictEqual(expectedCheck(ITEM_CODES));
  expect(checkAutoPayoutEnable(new Map(), 30)).toStrictEqual(expectedCheck(ITEM_CODES));
});

it('[AC-B2-11d#12] ② ⑤ ⑧ 都判为支持、对账连续跑通天数达到负责人定的天数 → 通过，四项按 ② ⑤ ⑧ 天数顺序列出', () => {
  expect(checkAutoPayoutEnable(enablePassing(), 7)).toStrictEqual(expectedCheck([]));
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
    expect(checkAutoPayoutEnable(withValue(key, value), 7)).toStrictEqual(expectedCheck([code]));
  },
);

it.each([
  { required: 7, passed: 7, ok: true },
  { required: 7, passed: 30, ok: true },
  { required: 1, passed: 1, ok: true },
  { required: 7, passed: 6, ok: false },
  { required: 30, passed: 0, ok: false },
  { required: 1, passed: 0, ok: false },
  { required: 0, passed: 0, ok: false },
  { required: 0, passed: 5, ok: false },
  { required: -1, passed: 5, ok: false },
  { required: undefined, passed: 30, ok: false },
  { required: null, passed: 30, ok: false },
  { required: '7', passed: 7, ok: false },
  { required: 7.5, passed: 30, ok: false },
  { required: true, passed: 30, ok: false },
  { required: 7, passed: 7.5, ok: false },
  { required: 7, passed: -1, ok: false },
  { required: 7, passed: Number.NaN, ok: false },
])(
  '[AC-B2-11d#14] 对账天数：负责人定 $required 天、已连续跑通 $passed 天 → recon_days 通过=$ok（未设即不满足，设了须为正整数）',
  ({ required, passed, ok }) => {
    const values = withValue(RECON_REQUIRED_DAYS, required);
    expect(checkAutoPayoutEnable(values, passed)).toStrictEqual(
      expectedCheck(ok ? [] : ['recon_days']),
    );
  },
);

it('[AC-B2-11d#15] 几项同时不满足：全部标出，列表仍是四项、顺序不变', () => {
  const values = enablePassing();
  values.set(STATUS_CODES_SUPPORTED, false);
  expect(checkAutoPayoutEnable(values, 2)).toStrictEqual(
    expectedCheck(['status_codes_supported', 'recon_days']),
  );
});

it('[AC-B2-11d#16] 跑通天数是事实不是配置：值里带着 recon_passed_days 也不算数，只看传入的天数', () => {
  const values = enablePassing();
  values.set(RETIRED_PASSED_DAYS, 30);
  expect(checkAutoPayoutEnable(values, 0)).toStrictEqual(expectedCheck(['recon_days']));
  expect(checkAutoPayoutEnable(values, 7)).toStrictEqual(expectedCheck([]));
});

/** A config port over `rows` and a reconciliation port answering `days`, recording each call. */
function ports(rows: ReadonlyMap<string, unknown>, days: number) {
  const reads: Array<{ appId: string; key: string; handle: unknown }> = [];
  const asked: Array<{ appId: string; handle: unknown }> = [];
  const config: PayoutConfigPort = {
    configValue(appId, key, handle) {
      reads.push({ appId, key, handle });
      return Promise.resolve(rows.has(key) ? { value: rows.get(key), version: 1 } : null);
    },
  };
  const recon: ReconPassedDaysPort = {
    passedDays(appId, handle) {
      asked.push({ appId, handle });
      return Promise.resolve(days);
    },
  };
  return { config, recon, reads, asked };
}

const HANDLE = {} as Parameters<typeof readAutoPayoutEnableCheck>[1];

it('[AC-B2-11d#17] 读配置口：用调用方的 appId 与 handle 读四个键、向对账口问跑通天数，全部达标 → 通过', async () => {
  const p = ports(enablePassing(), 7);
  await expect(
    readAutoPayoutEnableCheck('app-1', HANDLE, { config: p.config, recon: p.recon }),
  ).resolves.toStrictEqual(expectedCheck([]));
  expect([...new Set(p.reads.map((read) => read.key))].sort()).toStrictEqual(
    [...ENABLE_KEYS].sort(),
  );
  for (const read of p.reads) {
    expect(read.appId).toBe('app-1');
    expect(read.handle).toBe(HANDLE);
  }
  expect(p.asked.length).toBeGreaterThan(0);
  for (const ask of p.asked) {
    expect(ask.appId).toBe('app-1');
    expect(ask.handle).toBe(HANDLE);
  }
});

it('[AC-B2-11d#18] 读配置口：库里没有这些行 → 四项全部不通过（缺省不通过），对账跑通再久也一样', async () => {
  const p = ports(new Map(), 365);
  await expect(
    readAutoPayoutEnableCheck('app-1', HANDLE, { config: p.config, recon: p.recon }),
  ).resolves.toStrictEqual(expectedCheck(ITEM_CODES));
});

it('[AC-B2-11d#19] 读配置口：跑通天数只取对账口——库里写着 recon_passed_days=30 也不读，对账口说 3 天 → 只有 recon_days 不通过', async () => {
  const rows = enablePassing();
  rows.set(RETIRED_PASSED_DAYS, 30);
  const p = ports(rows, 3);
  await expect(
    readAutoPayoutEnableCheck('app-1', HANDLE, { config: p.config, recon: p.recon }),
  ).resolves.toStrictEqual(expectedCheck(['recon_days']));
  expect(p.reads.map((read) => read.key)).not.toContain(RETIRED_PASSED_DAYS);
});

it('[AC-B2-11d#20] 打款日对账落地前的缺省对账口返回 0 天：其余全部填好也不能开启（fail-closed）', async () => {
  const recon = createDefaultReconPassedDays();
  await expect(recon.passedDays('app-1', HANDLE)).resolves.toBe(0);
  const p = ports(enablePassing(), 0);
  await expect(
    readAutoPayoutEnableCheck('app-1', HANDLE, { config: p.config, recon }),
  ).resolves.toStrictEqual(expectedCheck(['recon_days']));
});
