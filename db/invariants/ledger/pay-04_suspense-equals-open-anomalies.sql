-- BR-PAY-07 细则「不变量」④：PAY_SUSPENSE 的余额等于未退完的异常收款合计（正文：PAY_ANOMALY 登记时贷 PAY_SUSPENSE，对异常收款退款成功时写相反方向；BR-PAY-05 ④）。
-- 任务 B2-15j。只读，一条 SELECT，检查全量（不按会计日过滤，couli.check_date 不参与）。
--
-- 口径
-- - 应有：每个 app 的 Σ(pay_anomalies.amount_fen − refunded_fen)，即未退完的异常收款合计（退完的
--   一条差额为 0；处理中的退款不减少待退金额，refunded_fen 只随退款成功增加）。
-- - 实有：该 app 平台科目 PAY_SUSPENSE 上全部分录合计的相反数（贷方余额记为正）。
-- - 按 app 对上：另一 app 多出的 PAY_SUSPENSE 不能抵消本 app 的缺口；有异常收款却从未有
--   PAY_SUSPENSE 分录（实有 0）或有分录却没有异常收款（应有 0）都报。不符的每个 app 一行（global）。
-- - 合计用 sum(bigint) = numeric，精确；detail 金额写成文本，避免 JSON 数字丢精度。
-- - checked_rows = 有异常收款或有 PAY_SUSPENSE 分录的 app 数。
WITH open_anomalies AS (
  SELECT
    pa.app_id,
    count(*) AS anomaly_count,
    sum(pa.amount_fen - pa.refunded_fen) AS open_fen
  FROM app.pay_anomalies pa
  GROUP BY pa.app_id
),
suspense AS (
  SELECT
    e.app_id,
    count(*) AS entry_count,
    -sum(e.amount_fen) AS balance_fen
  FROM app.ledger_entries e
  JOIN app.ledger_accounts a ON a.app_id = e.app_id AND a.id = e.account_id
  WHERE a.owner_type = 'platform' AND a.subject = 'PAY_SUSPENSE'
  GROUP BY e.app_id
),
population AS (
  SELECT
    COALESCE(oa.app_id, su.app_id) AS app_id,
    COALESCE(oa.anomaly_count, 0) AS anomaly_count,
    COALESCE(oa.open_fen, 0) AS expected_fen,
    COALESCE(su.entry_count, 0) AS entry_count,
    COALESCE(su.balance_fen, 0) AS actual_fen
  FROM open_anomalies oa
  FULL OUTER JOIN suspense su ON su.app_id = oa.app_id
),
differences AS (
  SELECT
    pp.app_id,
    jsonb_build_object(
      'anomaly_count', pp.anomaly_count::text,
      'suspense_entry_count', pp.entry_count::text,
      'expected_suspense_fen', pp.expected_fen::text,
      'actual_suspense_fen', pp.actual_fen::text
    ) AS detail
  FROM population pp
  WHERE pp.expected_fen <> pp.actual_fen
),
stats AS (
  SELECT count(*) AS checked_rows FROM population
)
SELECT
  'pay-04'::text AS invariant,
  st.checked_rows,
  'global'::text AS scope,
  df.app_id,
  NULL::uuid AS account_id,
  df.detail
FROM differences df
CROSS JOIN stats st
UNION ALL
SELECT
  'pay-04'::text AS invariant,
  st.checked_rows,
  'none'::text AS scope,
  NULL::text AS app_id,
  NULL::uuid AS account_id,
  NULL::jsonb AS detail
FROM stats st
WHERE NOT EXISTS (SELECT 1 FROM differences)
ORDER BY app_id, detail
