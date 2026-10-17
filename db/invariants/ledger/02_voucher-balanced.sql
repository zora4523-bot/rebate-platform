-- BR-FUND-19 ② 全局：每张凭证 Σ amount_fen = 0。
-- 任务 B2-02e。只读，一条 SELECT，检查全量（不按会计日过滤）。
--
-- 口径
-- - 凭证按 (app_id, id) 与分录对上（分录外键就是这两列），不同 app 的同名 uniq_key 各自核对。
-- - 每张不守恒的凭证单独一行，正负两张错误凭证不会互相抵消。
-- - 合计用 sum(bigint) = numeric，精确；detail 里的金额写成文本，避免 JSON 数字丢精度。
-- - checked_rows = 凭证张数。
WITH voucher_sums AS (
  SELECT
    v.app_id,
    v.id AS voucher_id,
    v.uniq_key,
    v.accounting_date,
    count(e.id) AS entry_count,
    COALESCE(sum(e.amount_fen), 0) AS amount_sum_fen
  FROM app.ledger_vouchers v
  LEFT JOIN app.ledger_entries e ON e.app_id = v.app_id AND e.voucher_id = v.id
  GROUP BY v.app_id, v.id, v.uniq_key, v.accounting_date
),
differences AS (
  SELECT
    vs.app_id,
    jsonb_build_object(
      'voucher_id', vs.voucher_id::text,
      'uniq_key', vs.uniq_key,
      'accounting_date', vs.accounting_date::text,
      'entry_count', vs.entry_count::text,
      'expected_sum_fen', '0',
      'actual_sum_fen', vs.amount_sum_fen::text
    ) AS detail
  FROM voucher_sums vs
  WHERE vs.amount_sum_fen <> 0
),
stats AS (
  SELECT count(*) AS checked_rows FROM voucher_sums
)
SELECT
  '02'::text AS invariant,
  st.checked_rows,
  'global'::text AS scope,
  df.app_id,
  NULL::uuid AS account_id,
  df.detail
FROM differences df
CROSS JOIN stats st
UNION ALL
SELECT
  '02'::text AS invariant,
  st.checked_rows,
  'none'::text AS scope,
  NULL::text AS app_id,
  NULL::uuid AS account_id,
  NULL::jsonb AS detail
FROM stats st
WHERE NOT EXISTS (SELECT 1 FROM differences)
ORDER BY app_id, detail
