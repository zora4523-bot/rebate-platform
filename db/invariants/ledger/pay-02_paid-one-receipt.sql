-- BR-PAY-07 细则「不变量」②：每张 PAID 支付单恰有一张 PAY_RECEIPT 凭证（正文：每张支付单至多一张；BR-PAY-05 ④ CLOSED 单的收款只登记为异常收款）。
-- 任务 B2-15j。只读，一条 SELECT，检查全量（不按会计日过滤，couli.check_date 不参与）。
--
-- 口径
-- - 收款凭证：voucher_kind = PAY_RECEIPT，或任一分录的 ledger_type = PAY_RECEIPT（漏标 voucher_kind
--   的重复收款也要数到）；它引用的支付单是凭证的 biz_id。异常收款凭证（PAY_ANOMALY）不算收款凭证。
-- - 按 (app_id, 支付单) 对上：另一 app 同号的收款凭证不能替本 app 的 PAID 单充数。
-- - 被检查的是 PAID 支付单与收款凭证所引用的支付单的并集：PAID 单应有 1 张；非 PAID 单（PENDING、
--   CLOSED）或我方没有的支付单号应有 0 张。张数不符的每张支付单一行（global 级差异）。
-- - detail 写支付单 id、状态（没有该单写 none）、应有与实有张数（文本）与凭证 id 列表。
-- - checked_rows = 上述并集的行数。
WITH receipt_vouchers AS (
  SELECT v.app_id, v.id AS voucher_id, v.biz_id
  FROM app.ledger_vouchers v
  WHERE COALESCE(v.voucher_kind, '') = 'PAY_RECEIPT'
    OR EXISTS (
      SELECT 1
      FROM app.ledger_entries e
      WHERE e.app_id = v.app_id
        AND e.voucher_id = v.id
        AND e.ledger_type = 'PAY_RECEIPT'
    )
),
receipts AS (
  SELECT
    rv.app_id,
    rv.biz_id AS pay_order_id,
    count(*) AS receipt_count,
    jsonb_agg(rv.voucher_id::text ORDER BY rv.voucher_id) AS voucher_ids
  FROM receipt_vouchers rv
  GROUP BY rv.app_id, rv.biz_id
),
paid AS (
  SELECT o.app_id, o.id::text AS pay_order_id
  FROM app.pay_orders o
  WHERE o.status = 'PAID'
),
population AS (
  SELECT
    COALESCE(p.app_id, r.app_id) AS app_id,
    COALESCE(p.pay_order_id, r.pay_order_id) AS pay_order_id,
    COALESCE(r.receipt_count, 0) AS actual_count,
    COALESCE(r.voucher_ids, '[]'::jsonb) AS voucher_ids
  FROM paid p
  FULL OUTER JOIN receipts r ON r.app_id = p.app_id AND r.pay_order_id = p.pay_order_id
),
checked AS (
  SELECT
    pp.app_id,
    pp.pay_order_id,
    o.status,
    CASE WHEN o.status = 'PAID' THEN 1 ELSE 0 END AS expected_count,
    pp.actual_count,
    pp.voucher_ids
  FROM population pp
  LEFT JOIN app.pay_orders o ON o.app_id = pp.app_id AND o.id::text = pp.pay_order_id
),
differences AS (
  SELECT
    c.app_id,
    jsonb_build_object(
      'pay_order_id', c.pay_order_id,
      'status', COALESCE(c.status, 'none'),
      'expected_receipts', c.expected_count::text,
      'actual_receipts', c.actual_count::text,
      'voucher_ids', c.voucher_ids
    ) AS detail
  FROM checked c
  WHERE c.actual_count <> c.expected_count
),
stats AS (
  SELECT count(*) AS checked_rows FROM population
)
SELECT
  'pay-02'::text AS invariant,
  st.checked_rows,
  'global'::text AS scope,
  df.app_id,
  NULL::uuid AS account_id,
  df.detail
FROM differences df
CROSS JOIN stats st
UNION ALL
SELECT
  'pay-02'::text AS invariant,
  st.checked_rows,
  'none'::text AS scope,
  NULL::text AS app_id,
  NULL::uuid AS account_id,
  NULL::jsonb AS detail
FROM stats st
WHERE NOT EXISTS (SELECT 1 FROM differences)
ORDER BY app_id, detail
