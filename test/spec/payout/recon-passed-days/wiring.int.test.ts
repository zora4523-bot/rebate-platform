// B2-07d (规划/08 BR-WDR-30 细则「开启前置检查」, BR-WDR-17; 编排裁定 D10-392, D10-408; task brief
// §9.3「接线」): the admin entry as assembled for production asks the real reconciliation port
// when withdraw.auto_payout.enabled is turned on (PUT /admin/v1/kill-switches/{key}), so the days
// stored in app.payout_recon_runs decide the recon_days item instead of D10-392's constant 0.
// With BR-WDR-22 ② ⑤ ⑧ judged supported: fewer consecutive succeeded days than
// recon_required_days, or recon_required_days not set, is refused 20001 [value] with nothing
// written; enough days (差错 found on one of them) lets the owner turn it on. The admin harness's
// clock is 2026-10-09 10:00 +08:00: 「昨日」 is 2026-10-08.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  item,
  owner,
  put,
  rejected,
  seedSwitch,
  setup,
  stepUp,
  updated,
  type Setup,
} from '../../content/kill-switches/kit.ts';
import { daysBack, rerun, seedRuns, succeeded } from './kit.ts';

const h = useHarness();

const AUTO = 'withdraw.auto_payout.enabled';
const SUPPORT_KEYS = [
  'payout.auto_enable_check.limits_supported',
  'payout.auto_enable_check.status_codes_supported',
  'payout.auto_enable_check.bill_out_biz_no_supported',
] as const;
const RECON_REQUIRED_DAYS = 'payout.auto_enable_check.recon_required_days';
const HARNESS_TODAY = '2026-10-09';
const HARNESS_YESTERDAY = '2026-10-08';

async function supported(f: Setup): Promise<void> {
  for (const key of SUPPORT_KEYS) await seedSwitch(h, f.appId, key, true, 1);
}

async function turnOn(f: Setup) {
  const token = await stepUp(f, owner(f));
  return put(f.app, owner(f), AUTO, { value: true, expected_version: 0 }, token);
}

async function refused(f: Setup): Promise<void> {
  await rejected(await turnOn(f), 'update', 20001, { fields: ['value'] });
  expect(await item(h, f.appId, AUTO)).toBeUndefined();
}

it('[AC-B2-07d#18] 后台打开自动到账：负责人定 3 天，库里从昨日起只连续跑通 2 天 → 20001 [value] 不写；补上第 3 天（当天发现差错）后可以打开', async () => {
  const f = await setup(h);
  // The harness's +08:00 day, which every bill day here is counted from.
  const china = new Date(f.clock.now().getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
  expect(china).toBe(HARNESS_TODAY);
  await supported(f);
  await seedSwitch(h, f.appId, RECON_REQUIRED_DAYS, 3, 1);
  const days = daysBack(HARNESS_YESTERDAY, 3);
  await seedRuns(h.db, f.appId, [
    { billDate: HARNESS_TODAY, status: 'failed' },
    ...succeeded(days.slice(0, 2)),
  ]);
  await refused(f);
  await seedRuns(h.db, f.appId, [{ billDate: days[2]!, status: 'succeeded', diffs: 2 }]);
  const row = await updated(await turnOn(f));
  expect(row).toMatchObject({ key: AUTO, value: true, version: 1 });
  expect(await item(h, f.appId, AUTO)).toMatchObject({ value: true, version: 1 });
});

it('[AC-B2-07d#19] 后台打开自动到账：昨日 partial 打断连续天数 → 20001 [value]；重跑改为 succeeded 后连续 5 天 ≥ 5 → 可以打开', async () => {
  const f = await setup(h);
  await supported(f);
  await seedSwitch(h, f.appId, RECON_REQUIRED_DAYS, 5, 1);
  const days = daysBack(HARNESS_YESTERDAY, 5);
  await seedRuns(h.db, f.appId, [
    { billDate: days[0]!, status: 'partial' },
    ...succeeded(days.slice(1)),
  ]);
  await refused(f);
  await rerun(h.db, f.appId, days[0]!, 'succeeded');
  const row = await updated(await turnOn(f));
  expect(row).toMatchObject({ key: AUTO, value: true, version: 1 });
});

it('[AC-B2-07d#20] 未配置 recon_required_days：库里连续跑通 30 天也拒绝 20001 [value]；负责人定 30 天后同样的记录可以打开', async () => {
  const f = await setup(h);
  await supported(f);
  await seedRuns(h.db, f.appId, succeeded(daysBack(HARNESS_YESTERDAY, 30)));
  await refused(f);
  await seedSwitch(h, f.appId, RECON_REQUIRED_DAYS, 30, 1);
  const row = await updated(await turnOn(f));
  expect(row).toMatchObject({ key: AUTO, value: true, version: 1 });
});
