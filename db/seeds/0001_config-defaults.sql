-- Configuration defaults from 规划/08_业务规则 at SPEC_REF 826f86ef3bb76738e3c99998d7d31516838d1539.
-- Synthetic app_id/actor only. Re-running preserves every existing value and revision,
-- including values changed by an operator; this is initialization, not a config update.
-- Scope: c-03, b2-40, b3-39, b4-32, fa-24. Excluded by the task: sms.* / device.*
-- thresholds and share.tpwd_rate_per_min (D-7; orchestrator 2026-10-04: rate limits are risk parameters), help_links.* (D-8), derived claim.window_days / features.*,
-- link_patterns (specs), and search.enabled.<platform> (kill_switches, 04 §10.2).

INSERT INTO app.config_items (app_id, key, value, updated_by) VALUES
  -- 第 1 批：c-03
  ('couli', 'union.taobao.auth_methods.ios', '["web_code"]'::jsonb, 'seed'), -- BR-ID-17 细则
  ('couli', 'union.taobao.auth_methods.android', '["web_code"]'::jsonb, 'seed'), -- BR-ID-17 细则
  ('couli', 'union.taobao.auth_methods.harmony', '["web_code"]'::jsonb, 'seed'), -- BR-ID-17 细则
  ('couli', 'external_page.union_host_block', 'true'::jsonb, 'seed'), -- BR-ATTR-29
  ('couli', 'external_page.nav_host_sample_bp', '1000'::jsonb, 'seed'), -- BR-ATTR-29 细则
  ('couli', 'share.open_in_app.enabled', 'true'::jsonb, 'seed'), -- BR-ATTR-05 细则
  ('couli', 'invite.bind_phone_guide', 'true'::jsonb, 'seed'), -- BR-INV-21、BR-INV-03 细则
  ('couli', 'invite.before_buy_tip', 'true'::jsonb, 'seed'), -- BR-INV-21、BR-INV-03 细则
  ('couli', 'auth.oauth_attempt_ttl_sec', '600'::jsonb, 'seed'), -- BR-ID-04 细则
  -- 第 2 批：b2-40
  ('couli', 'rebate.pdd.compare_precheck.enabled', 'false'::jsonb, 'seed'), -- BR-PRICE-07 细则
  ('couli', 'earnings.dashboard.enabled', 'true'::jsonb, 'seed'), -- BR-FUND-25
  ('couli', 'earnings.dashboard.referral_visible', 'true'::jsonb, 'seed'), -- BR-FUND-25
  ('couli', 'withdraw.payout_account_verify_per_day', '3'::jsonb, 'seed'), -- BR-WDR-02 细则
  ('couli', 'withdraw.payout_account_verify_inflight_timeout_sec', '60'::jsonb, 'seed'), -- BR-WDR-02 细则
  ('couli', 'withdraw.payout_account_verify_recheck_minutes', '30'::jsonb, 'seed'), -- BR-WDR-02 细则
  ('couli', 'withdraw.payout_account_verify_reuse_hours', '24'::jsonb, 'seed'), -- BR-WDR-02 细则
  ('couli', 'order.user_query_months', '0'::jsonb, 'seed'), -- BR-ID-30 细则
  ('couli', 'push.token_conflict_window_hours', '24'::jsonb, 'seed'), -- BR-ID-07 细则
  -- 第 3 批：b3-39
  ('couli', 'external_hosts', '[]'::jsonb, 'seed'), -- BR-ID-10 细则
  ('couli', 'app_update.recheck_interval_sec', '1800'::jsonb, 'seed'), -- BR-ID-01 细则
  -- 第 4 批：b4-32
  ('couli', 'risk.merge_tombstone_dedupe', 'true'::jsonb, 'seed'), -- BR-ID-05、BR-ID-37 引用 08 §13.2 第 4 批行
  ('couli', 'attr.track_complete_tolerance_sec', '120'::jsonb, 'seed'), -- BR-ATTR-21 细则
  -- 资金规则对齐：fa-24
  ('couli', 'settle.estimate_change_diff.enabled', 'true'::jsonb, 'seed'), -- BR-FUND-01 R9b
  ('couli', 'settle.adjust.void_on_clawback.enabled', 'true'::jsonb, 'seed'), -- BR-FUND-09
  ('couli', 'order_sync.regression_hold.enabled', 'true'::jsonb, 'seed'), -- BR-FUND-01 P10
  ('couli', 'order_sync.unmapped_status_hold.enabled', 'true'::jsonb, 'seed'), -- BR-FUND-02
  ('couli', 'ledger.bad_debt_require_no_frozen.enabled', 'true'::jsonb, 'seed'), -- BR-FUND-12
  ('couli', 'payout.proven_success_writeoff.enabled', 'true'::jsonb, 'seed') -- BR-WDR-08、BR-WDR-17
ON CONFLICT (app_id, key) DO NOTHING;
