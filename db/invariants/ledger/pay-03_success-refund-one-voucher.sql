-- BR-PAY-07 细则「不变量」③：每张 SUCCESS 退款单恰有一张 PAY_REFUND（或对异常收款的反向 PAY_ANOMALY）凭证（正文：退款单 SUCCESS 时写、每张至多一张；BR-PAY-06 ⑤）。
-- 任务 B2-15j。只读，一条 SELECT，检查全量（不按会计日过滤，couli.check_date 不参与）。
--
-- 口径
-- - 退款凭证：biz_type = pay_refund，或 voucher_kind = PAY_REFUND，或任一分录的 ledger_type =
--   PAY_REFUND；它引用的退款单是凭证的 biz_id。
-- - 对的那张：支付单的退款是 PAY_REFUND 类（凭证或分录类型为 PAY_REFUND、不含 PAY_ANOMALY）；异常收款
--   的退款是反向 PAY_ANOMALY（凭证或分录类型为 PAY_ANOMALY、不含 PAY_REFUND，且借记 PAY_SUSPENSE，
--   即该凭证在平台 PAY_SUSPENSE 上的分录合计为正）。
-- - 按 (app_id, 退款单) 对上；被检查的是 SUCCESS 退款单与退款凭证所引用的退款单的并集。SUCCESS 退款单
--   要求恰一张凭证且就是对的那张；非 SUCCESS（PROCESSING、FAILED）或我方没有的退款单号应有 0 张。
--   不符的每张退款单一行（global 级差异）。
-- - detail 写退款单 id、退款单号、状态与对象类型（没有该单写 none）、应有的凭证类型（不应有写 none）、
--   应有 / 实有 / 对的张数（文本）与凭证 id 列表。
-- - checked_rows = 上述并集的行数。
WITH voucher_facts AS (
  SELECT
    v.app_id,
    v.id AS voucher_id,
    v.biz_type,
    v.biz_id,
    COALESCE(v.voucher_kind, '') AS voucher_kind,
    COALESCE(bool_or(e.ledger_type = 'PAY_REFUND'), false) AS has_refund_entry,
    COALESCE(bool_or(e.ledger_type = 'PAY_ANOMALY'), false) AS has_anomaly_entry,
    COALESCE(
      sum(e.amount_fen) FILTER (WHERE a.owner_type = 'platform' AND a.subject = 'PAY_SUSPENSE'),
      0
    ) AS suspense_sum_fen
  FROM app.ledger_vouchers v
  LEFT JOIN app.ledger_entries e ON e.app_id = v.app_id AND e.voucher_id = v.id
  LEFT JOIN app.ledger_accounts a ON a.app_id = e.app_id AND a.id = e.account_id
  GROUP BY v.app_id, v.id, v.biz_type, v.biz_id, v.voucher_kind
),
refund_vouchers AS (
  SELECT
    vf.app_id,
    vf.voucher_id,
    vf.biz_id AS pay_refund_id,
    (vf.voucher_kind = 'PAY_REFUND' OR vf.has_refund_entry) AS refund_kind,
    (vf.voucher_kind = 'PAY_ANOMALY' OR vf.has_anomaly_entry) AS anomaly_kind,
    vf.suspense_sum_fen
  FROM voucher_facts vf
  WHERE vf.biz_type = 'pay_refund' OR vf.voucher_kind = 'PAY_REFUND' OR vf.has_refund_entry
),
per_refund AS (
  SELECT
    rv.app_id,
    rv.pay_refund_id,
    count(*) AS voucher_count,
    count(*) FILTER (WHERE rv.refund_kind AND NOT rv.anomaly_kind) AS refund_kind_count,
    count(*) FILTER (
      WHERE rv.anomaly_kind AND NOT rv.refund_kind AND rv.suspense_sum_fen > 0
    ) AS reverse_anomaly_count,
    jsonb_agg(rv.voucher_id::text ORDER BY rv.voucher_id) AS voucher_ids
  FROM refund_vouchers rv
  GROUP BY rv.app_id, rv.pay_refund_id
),
succeeded AS (
  SELECT r.app_id, r.id::text AS pay_refund_id
  FROM app.pay_refunds r
  WHERE r.status = 'SUCCESS'
),
population AS (
  SELECT
    COALESCE(s.app_id, pr.app_id) AS app_id,
    COALESCE(s.pay_refund_id, pr.pay_refund_id) AS pay_refund_id,
    COALESCE(pr.voucher_count, 0) AS voucher_count,
    COALESCE(pr.refund_kind_count, 0) AS refund_kind_count,
    COALESCE(pr.reverse_anomaly_count, 0) AS reverse_anomaly_count,
    COALESCE(pr.voucher_ids, '[]'::jsonb) AS voucher_ids
  FROM succeeded s
  FULL OUTER JOIN per_refund pr ON pr.app_id = s.app_id AND pr.pay_refund_id = s.pay_refund_id
),
checked AS (
  SELECT
    pp.app_id,
    pp.pay_refund_id,
    r.out_refund_no,
    COALESCE(r.status, 'none') AS status,
    COALESCE(r.target_type, 'none') AS target_type,
    CASE
      WHEN r.status = 'SUCCESS' AND r.target_type = 'pay_anomaly' THEN 'PAY_ANOMALY'
      WHEN r.status = 'SUCCESS' THEN 'PAY_REFUND'
      ELSE 'none'
    END AS expected_kind,
    CASE WHEN r.status = 'SUCCESS' THEN 1 ELSE 0 END AS expected_count,
    pp.voucher_count,
    CASE
      WHEN r.target_type = 'pay_anomaly' THEN pp.reverse_anomaly_count
      ELSE pp.refund_kind_count
    END AS matching_count,
    pp.voucher_ids
  FROM population pp
  LEFT JOIN app.pay_refunds r ON r.app_id = pp.app_id AND r.id::text = pp.pay_refund_id
),
differences AS (
  SELECT
    c.app_id,
    jsonb_build_object(
      'pay_refund_id', c.pay_refund_id,
      'out_refund_no', c.out_refund_no,
      'status', c.status,
      'target_type', c.target_type,
      'expected_voucher_kind', c.expected_kind,
      'expected_vouchers', c.expected_count::text,
      'actual_vouchers', c.voucher_count::text,
      'matching_vouchers', c.matching_count::text,
      'voucher_ids', c.voucher_ids
    ) AS detail
  FROM checked c
  WHERE (c.expected_count = 1 AND NOT (c.voucher_count = 1 AND c.matching_count = 1))
    OR (c.expected_count = 0 AND c.voucher_count > 0)
),
stats AS (
  SELECT count(*) AS checked_rows FROM population
)
SELECT
  'pay-03'::text AS invariant,
  st.checked_rows,
  'global'::text AS scope,
  df.app_id,
  NULL::uuid AS account_id,
  df.detail
FROM differences df
CROSS JOIN stats st
UNION ALL
SELECT
  'pay-03'::text AS invariant,
  st.checked_rows,
  'none'::text AS scope,
  NULL::text AS app_id,
  NULL::uuid AS account_id,
  NULL::jsonb AS detail
FROM stats st
WHERE NOT EXISTS (SELECT 1 FROM differences)
ORDER BY app_id, detail
