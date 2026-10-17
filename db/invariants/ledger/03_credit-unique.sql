-- BR-FUND-19 ③ 全局：每个 (子订单, 受益人, 角色) 的 CREDIT 凭证 ≤ 1。
-- 任务 B2-02e。只读，一条 SELECT，检查全量（不按会计日过滤）。
--
-- 口径
-- - 归集只用凭证结构化列（ledger-plan D3 A）：app_id、order_key、beneficiary_user_id、role，
--   voucher_kind = CREDIT。结构化列任一为空的凭证不构成受益人键，不参与（不解析 uniq_key）。
-- - 数的是凭证张数，不是分录条数（一张凭证可有 available、frozen 等多条分录）。
-- - checked_rows = 参与核对的 (app_id, 子订单, 受益人, 角色) 键数。
WITH credit_keys AS (
  SELECT
    v.app_id,
    v.order_key,
    v.beneficiary_user_id,
    v.role,
    count(*) AS credit_vouchers,
    jsonb_agg(v.id::text ORDER BY v.id) AS voucher_ids,
    jsonb_agg(v.uniq_key ORDER BY v.id) AS uniq_keys
  FROM app.ledger_vouchers v
  WHERE v.voucher_kind = 'CREDIT'
    AND v.order_key IS NOT NULL
    AND v.beneficiary_user_id IS NOT NULL
    AND v.role IS NOT NULL
  GROUP BY v.app_id, v.order_key, v.beneficiary_user_id, v.role
),
differences AS (
  SELECT
    ck.app_id,
    jsonb_build_object(
      'order_key', ck.order_key,
      'beneficiary_user_id', ck.beneficiary_user_id::text,
      'role', ck.role,
      'max_credit_vouchers', '1',
      'credit_vouchers', ck.credit_vouchers::text,
      'voucher_ids', ck.voucher_ids,
      'uniq_keys', ck.uniq_keys
    ) AS detail
  FROM credit_keys ck
  WHERE ck.credit_vouchers > 1
),
stats AS (
  SELECT count(*) AS checked_rows FROM credit_keys
)
SELECT
  '03'::text AS invariant,
  st.checked_rows,
  'global'::text AS scope,
  df.app_id,
  NULL::uuid AS account_id,
  df.detail
FROM differences df
CROSS JOIN stats st
UNION ALL
SELECT
  '03'::text AS invariant,
  st.checked_rows,
  'none'::text AS scope,
  NULL::text AS app_id,
  NULL::uuid AS account_id,
  NULL::jsonb AS detail
FROM stats st
WHERE NOT EXISTS (SELECT 1 FROM differences)
ORDER BY app_id, detail
