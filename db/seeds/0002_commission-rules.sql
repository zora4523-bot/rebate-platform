-- Placeholder commission rule version and its configuration (08 BR-CALC-06 细则「默认种子数据」,
-- BR-CALC-05 细则, BR-CALC-02, BR-CALC-17 at SPEC_REF 7c268cb097cb90e0504e2bef474fb5c2cdb6565b).
-- Development and test values only: the production version is published by the super admin in
-- the admin console (BR-CALC-22, 拍板第二批 §8 ADD-03). Synthetic app_id only.
-- Re-runnable: the version uses a fixed uuid and every INSERT is ON CONFLICT DO NOTHING, so a
-- second run changes nothing and config values changed by an operator are kept. Uses only
-- SELECT / INSERT, so it also runs as couli_app (test/spec/db/content/kit.ts).

-- One published version, indirect rewards off, in effect from 2026-01-01 (+08:00).
INSERT INTO app.commission_rule_versions
  (rule_version_id, app_id, status, effective_from, indirect_enabled, published_at)
VALUES
  ('0192f000-0000-7000-8000-00000000b201', 'couli', 'published',
   '2026-01-01T00:00:00+08:00', false, '2026-01-01T00:00:00+08:00')
ON CONFLICT DO NOTHING;

-- commission.platforms × {L1, L2, L3} × {self, share} = 18 rows: r_own 5000, r_direct 1000,
-- r_indirect 0 (BR-CALC-06 细则; 0 because the version has indirect_enabled = false, BR-CALC-05).
INSERT INTO app.commission_rules
  (rule_version_id, app_id, platform, level, order_type, r_own_bp, r_direct_bp, r_indirect_bp)
SELECT '0192f000-0000-7000-8000-00000000b201', 'couli', p.platform, l.level, o.order_type,
  5000, 1000, 0
FROM (VALUES ('taobao'), ('jd'), ('pdd')) AS p (platform)
CROSS JOIN (VALUES ('L1'), ('L2'), ('L3')) AS l (level)
CROSS JOIN (VALUES ('self'), ('share')) AS o (order_type)
ON CONFLICT DO NOTHING;

-- One reserve per platform, reserve_bp 0 (BR-CALC-06 细则, BR-CALC-02).
INSERT INTO app.commission_rule_reserves (rule_version_id, app_id, platform, reserve_bp)
VALUES
  ('0192f000-0000-7000-8000-00000000b201', 'couli', 'taobao', 0),
  ('0192f000-0000-7000-8000-00000000b201', 'couli', 'jd', 0),
  ('0192f000-0000-7000-8000-00000000b201', 'couli', 'pdd', 0)
ON CONFLICT DO NOTHING;

INSERT INTO app.config_items (app_id, key, value, updated_by) VALUES
  ('couli', 'commission.platforms', '["taobao", "jd", "pdd"]'::jsonb, 'seed'), -- BR-CALC-06 细则
  ('couli', 'union.pdd.account_level_factor_bp', '10000'::jsonb, 'seed'), -- BR-CALC-17 细则（待核实）
  ('couli', 'union.pdd.self_buy_factor_bp', '7500'::jsonb, 'seed') -- BR-CALC-17 细则（待核实）
ON CONFLICT (app_id, key) DO NOTHING;
