// Rule tests for the configuration default seed of F1-02a (db/seeds/README.md: re-runnable,
// synthetic data only, no risk-control parameters; 08 §13.2 configuration-key rows of the
// 2026-10-03 batches 1–4 and of the fund-rule alignment, values only from the BR each key belongs
// to, at SPEC_REF 826f86e). Orchestrator decisions in the task brief: D-7 sms.* / device.*
// thresholds stay out of the seed, D-8 help_links.* stays out, derived values (claim.window_days,
// features.*) stay out. Real PostgreSQL as couli_app (see runConfigSeeds in kit.ts for why).
// Top-level it() only (规划/11 §4.3).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { configSeedFiles, runConfigSeeds, sqlState, useDb } from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  useDb(app);
  await runConfigSeeds();
});

afterAll(async () => {
  await destroyDb(app);
  await database.drop();
});

/** Key → default value as JSON, with the rule that states it. on / off are JSON booleans. */
const DEFAULTS: readonly { key: string; value: unknown; source: string }[] = [
  // 第 1 批（c-03）
  ...['ios', 'android', 'harmony'].map((client) => ({
    key: `union.taobao.auth_methods.${client}`,
    value: ['web_code'],
    source: 'BR-ID-17 细则：默认 ["web_code"]',
  })),
  {
    key: 'external_page.union_host_block',
    value: true,
    source: 'BR-ATTR-29：开关 external_page.union_host_block 默认 on',
  },
  {
    key: 'external_page.nav_host_sample_bp',
    value: 1000,
    source: 'BR-ATTR-29 细则「覆盖限制与待定事项」：默认 1000，即 10%',
  },
  {
    key: 'share.open_in_app.enabled',
    value: true,
    source: 'BR-ATTR-05 细则（分享中间页）：share.open_in_app.enabled 默认 on',
  },
  {
    key: 'invite.bind_phone_guide',
    value: true,
    source: 'BR-INV-21 细则：config.invite.bind_phone_guide=on（BR-INV-03 细则）',
  },
  {
    key: 'invite.before_buy_tip',
    value: true,
    source: 'BR-INV-21 细则：config.invite.before_buy_tip=on（BR-INV-03 细则）',
  },
  {
    key: 'auth.oauth_attempt_ttl_sec',
    value: 600,
    source: 'BR-ID-04 细则：有效期 600 秒（配置 auth.oauth_attempt_ttl_sec）',
  },
  // 第 2 批（b2-40，D-7 之外）
  {
    key: 'rebate.pdd.compare_precheck.enabled',
    value: false,
    source: 'BR-PRICE-07 细则「拼多多的比价预判」：默认 off',
  },
  {
    key: 'earnings.dashboard.enabled',
    value: true,
    source: 'BR-FUND-25：earnings.dashboard.enabled 默认 on',
  },
  {
    key: 'earnings.dashboard.referral_visible',
    value: true,
    source: 'BR-FUND-25：earnings.dashboard.referral_visible 默认 on',
  },
  {
    key: 'withdraw.payout_account_verify_per_day',
    value: 3,
    source: 'BR-WDR-02 细则「核验次数上限」：默认 3',
  },
  {
    key: 'withdraw.payout_account_verify_inflight_timeout_sec',
    value: 60,
    source: 'BR-WDR-02 细则「在途租约」：默认 60 秒',
  },
  {
    key: 'withdraw.payout_account_verify_recheck_minutes',
    value: 30,
    source: 'BR-WDR-02 细则「复核的终点」：默认 30 分钟',
  },
  {
    key: 'withdraw.payout_account_verify_reuse_hours',
    value: 24,
    source: 'BR-WDR-02 细则「复用有效期」：默认 24 小时',
  },
  {
    key: 'order.user_query_months',
    value: 0,
    source: 'BR-ID-30 细则「订单类记录」：0 = 不限制，默认 0',
  },
  {
    key: 'push.token_conflict_window_hours',
    value: 24,
    source: 'BR-ID-07 细则「推送令牌与会话」：默认 24',
  },
  // 第 3 批（b3-39）
  {
    key: 'external_hosts',
    value: [],
    source: 'BR-ID-10 细则「深链能打开的第三方页面」：默认空',
  },
  {
    key: 'app_update.recheck_interval_sec',
    value: 1800,
    source: 'BR-ID-01 细则「最低支持版本的接口层拦截」：默认 1800 秒',
  },
  // 第 4 批（b4-32；search.enabled.<platform> 是 04 §10.2 的紧急开关，见报告）
  {
    key: 'risk.merge_tombstone_dedupe',
    value: true,
    source: '08 §13.2 第 4 批配置键行：boolean，默认 on（BR-ID-05、BR-ID-37 细则引用该行）',
  },
  {
    key: 'attr.track_complete_tolerance_sec',
    value: 120,
    source: 'BR-ATTR-21 细则「待跟单卡的完成与关闭按尝试」：默认 120 秒',
  },
  // 2026-10-03 资金规则对齐（fa-24）
  {
    key: 'settle.estimate_change_diff.enabled',
    value: true,
    source: 'BR-FUND-01 R9b：默认 on（决-01）',
  },
  {
    key: 'settle.adjust.void_on_clawback.enabled',
    value: true,
    source: 'BR-FUND-09 ②：默认 on（决-10）',
  },
  {
    key: 'order_sync.regression_hold.enabled',
    value: true,
    source: 'BR-FUND-01 P10：默认 on（决-12）',
  },
  {
    key: 'order_sync.unmapped_status_hold.enabled',
    value: true,
    source: 'BR-FUND-02：默认 on（决-05）',
  },
  {
    key: 'ledger.bad_debt_require_no_frozen.enabled',
    value: true,
    source: 'BR-FUND-12：默认 on（决-11）',
  },
  {
    key: 'payout.proven_success_writeoff.enabled',
    value: true,
    source: 'BR-WDR-08、BR-WDR-17：默认 on（决-08）',
  },
];

async function valuesOf(key: string): Promise<unknown[]> {
  const rows = await sql<{ value: unknown }>`
    SELECT value FROM app.config_items WHERE key = ${key} ORDER BY app_id
  `.execute(app);
  return rows.rows.map((r) => r.value);
}

async function snapshot(): Promise<unknown[]> {
  const rows = await sql<{ row: unknown }>`
    SELECT to_jsonb(c) AS row FROM app.config_items c ORDER BY app_id, key
  `.execute(app);
  return rows.rows.map((r) => r.row);
}

it('[AC-F1-02a#13] a seed file in db/seeds writes config_items', () => {
  expect(configSeedFiles().length).toBeGreaterThan(0);
});

DEFAULTS.forEach(({ key, value, source }, index) => {
  it(`[AC-F1-02a#${String(14 + index)}] seed: ${key} = ${JSON.stringify(value)} (${source})`, async () => {
    const values = await valuesOf(key);
    expect(values.length, key).toBeGreaterThan(0);
    for (const stored of values) expect(stored, key).toEqual(value);
  });
});

const NEXT = 14 + DEFAULTS.length;

it(`[AC-F1-02a#${String(NEXT)}] no risk-control threshold (incl. share.tpwd_rate_per_min, orchestrator 2026-10-04), help link or derived value is seeded (D-7, D-8)`, async () => {
  const rows = await sql<{ key: string }>`
    SELECT DISTINCT key FROM app.config_items
    WHERE key LIKE 'sms.%' OR key LIKE 'device.%' OR key LIKE 'help\_links%'
       OR key LIKE 'claim.%' OR key LIKE 'features.%' OR key LIKE 'link\_patterns%'
       OR key LIKE '%product\_intercept%'
       OR key = 'share.tpwd_rate_per_min'
    ORDER BY key
  `.execute(app);
  expect(rows.rows).toEqual([]);
  // The seed must actually have run for this to mean anything.
  expect((await snapshot()).length).toBeGreaterThanOrEqual(DEFAULTS.length);
});

it(`[AC-F1-02a#${String(NEXT + 1)}] running the seed again changes nothing`, async () => {
  const before = await snapshot();
  expect(before.length).toBeGreaterThan(0);
  expect(await sqlState(runConfigSeeds())).toBe('no error');
  expect(await sqlState(runConfigSeeds())).toBe('no error');
  expect(await snapshot()).toEqual(before);
});

it(`[AC-F1-02a#${String(NEXT + 2)}] re-running the seed keeps a value changed in the admin console`, async () => {
  await sql`
    UPDATE app.config_items SET value = '12'::jsonb WHERE key = 'order.user_query_months'
  `.execute(app);
  await sql`
    UPDATE app.config_items SET value = 'false'::jsonb WHERE key = 'earnings.dashboard.enabled'
  `.execute(app);
  expect(await sqlState(runConfigSeeds())).toBe('no error');
  for (const stored of await valuesOf('order.user_query_months')) expect(stored).toEqual(12);
  for (const stored of await valuesOf('earnings.dashboard.enabled')) expect(stored).toBe(false);
});
