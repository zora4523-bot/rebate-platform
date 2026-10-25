-- BR-PAY-07 细则「不变量」①：带支付单、退款单或异常收款引用的凭证里不得出现 USER_BALANCE 科目（正文：支付模块不得产生任何 USER_BALANCE 分录）。
-- 任务 B2-15j。只读，一条 SELECT，检查全量（不按会计日过滤，couli.check_date 不参与）。
--
-- 口径
-- - 收款类凭证：biz_type 为 pay_order / pay_refund / pay_anomaly / pay_bill（PAY_FEE 的账单引用），
--   或 voucher_kind 属 pay_ledger_type，或任一分录的 ledger_type 属 pay_ledger_type
--   （只有分录写了 PAY_* 而凭证没标 voucher_kind 的也算，漏标不能逃过检查）。
-- - 用户账户：ledger_accounts.owner_type = user（表约束保证其科目就是 USER_BALANCE），另把科目名为
--   USER_BALANCE 的账户也算上，口径只宽不窄。
-- - 每张收款类凭证、每个被它记到的用户账户一行（account 级差异，account_id 为该用户账户）；
--   detail 写凭证 id、唯一键、业务引用、凭证类型与该账户上的分录合计（文本，不经浮点）。
-- - checked_rows = 收款类凭证张数（用户侧返利等非收款凭证不计入）。
WITH pay_vouchers AS (
  SELECT
    v.app_id,
    v.id AS voucher_id,
    v.uniq_key,
    v.biz_type,
    v.biz_id,
    v.voucher_kind
  FROM app.ledger_vouchers v
  WHERE v.biz_type IN ('pay_order', 'pay_refund', 'pay_anomaly', 'pay_bill')
    OR v.voucher_kind IN ('PAY_RECEIPT', 'PAY_REFUND', 'PAY_ANOMALY', 'PAY_FEE')
    OR EXISTS (
      SELECT 1
      FROM app.ledger_entries pe
      WHERE pe.app_id = v.app_id
        AND pe.voucher_id = v.id
        AND pe.ledger_type IN ('PAY_RECEIPT', 'PAY_REFUND', 'PAY_ANOMALY', 'PAY_FEE')
    )
),
user_hits AS (
  SELECT
    pv.app_id,
    a.id AS account_id,
    pv.voucher_id,
    pv.uniq_key,
    pv.biz_type,
    pv.biz_id,
    pv.voucher_kind,
    count(e.id) AS entry_count,
    sum(e.amount_fen) AS amount_sum_fen
  FROM pay_vouchers pv
  JOIN app.ledger_entries e ON e.app_id = pv.app_id AND e.voucher_id = pv.voucher_id
  JOIN app.ledger_accounts a ON a.app_id = e.app_id AND a.id = e.account_id
  WHERE a.owner_type = 'user' OR a.subject = 'USER_BALANCE'
  GROUP BY pv.app_id, a.id, pv.voucher_id, pv.uniq_key, pv.biz_type, pv.biz_id, pv.voucher_kind
),
differences AS (
  SELECT
    uh.app_id,
    uh.account_id,
    jsonb_build_object(
      'voucher_id', uh.voucher_id::text,
      'uniq_key', uh.uniq_key,
      'biz_type', uh.biz_type,
      'biz_id', uh.biz_id,
      'voucher_kind', COALESCE(uh.voucher_kind, 'none'),
      'user_entry_count', uh.entry_count::text,
      'user_amount_sum_fen', uh.amount_sum_fen::text
    ) AS detail
  FROM user_hits uh
),
stats AS (
  SELECT count(*) AS checked_rows FROM pay_vouchers
)
SELECT
  'pay-01'::text AS invariant,
  st.checked_rows,
  'account'::text AS scope,
  df.app_id,
  df.account_id,
  df.detail
FROM differences df
CROSS JOIN stats st
UNION ALL
SELECT
  'pay-01'::text AS invariant,
  st.checked_rows,
  'none'::text AS scope,
  NULL::text AS app_id,
  NULL::uuid AS account_id,
  NULL::jsonb AS detail
FROM stats st
WHERE NOT EXISTS (SELECT 1 FROM differences)
ORDER BY app_id, account_id, detail
