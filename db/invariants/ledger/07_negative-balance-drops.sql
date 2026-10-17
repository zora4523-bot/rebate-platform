-- BR-FUND-19 ⑦ 账户级：用户账户中每条使 balance_after_fen < 0 且较前一条下降的分录，其 ledger_type
-- 属于 {CLAWBACK, SETTLE_ADJUST, ADMIN_ADJUST}，或属于改派红冲凭证（uniq_key 含 :REASSIGN_REV:，
-- 迁移 R14：红冲沿用原流水类型，按凭证键识别）。
-- 任务 B2-02e。只读，一条 SELECT，检查全量历史（不按会计日过滤：先按会计日过滤再取前一条会错比）。
--
-- 口径
-- - 只看用户账户（owner_type = user）上写了 balance_after_fen 的分录，平台账户不参与。
-- - 前一条 = 同一 (app_id, 账户, 子户) 内按 account_version 排在前面的那条（同版本再按分录 id），
--   不跨账户、app 或子户比较；没有前一条时按 0 比较，首笔就为负也要查。
-- - 下降 = balance_after_fen 小于前一条的 balance_after_fen；持平、回升、降到 0 都不算。
-- - 改派红冲只认 uniq_key 里的 :REASSIGN_REV: 片段（strpos 精确匹配，不用 LIKE，避免下划线通配），
--   sub_type 或 voucher_kind 写成 REASSIGN_REV 都不算。
-- - detail 里的金额写成文本，避免 JSON 数字丢精度。
-- - checked_rows = 参与核对的用户分录条数。
WITH user_entries AS (
  SELECT
    e.app_id,
    e.account_id,
    e.id AS entry_id,
    e.voucher_id,
    e.sub_account,
    e.ledger_type,
    e.sub_type,
    e.account_version,
    e.balance_after_fen,
    LAG(e.balance_after_fen) OVER (
      PARTITION BY e.app_id, e.account_id, e.sub_account
      ORDER BY e.account_version, e.id
    ) AS previous_balance_after_fen
  FROM app.ledger_entries e
  JOIN app.ledger_accounts a ON a.app_id = e.app_id AND a.id = e.account_id
  WHERE a.owner_type = 'user'
    AND e.balance_after_fen IS NOT NULL
),
differences AS (
  SELECT
    ue.app_id,
    ue.account_id,
    jsonb_build_object(
      'entry_id', ue.entry_id::text,
      'voucher_id', ue.voucher_id::text,
      'uniq_key', v.uniq_key,
      'ledger_type', ue.ledger_type,
      'sub_type', ue.sub_type,
      'sub_account', ue.sub_account,
      'account_version', ue.account_version::text,
      'has_previous', ue.previous_balance_after_fen IS NOT NULL,
      'previous_balance_after_fen', COALESCE(ue.previous_balance_after_fen, 0)::text,
      'balance_after_fen', ue.balance_after_fen::text,
      'allowed_ledger_types', jsonb_build_array('CLAWBACK', 'SETTLE_ADJUST', 'ADMIN_ADJUST')
    ) AS detail
  FROM user_entries ue
  JOIN app.ledger_vouchers v ON v.app_id = ue.app_id AND v.id = ue.voucher_id
  WHERE ue.balance_after_fen < 0
    AND ue.balance_after_fen < COALESCE(ue.previous_balance_after_fen, 0)
    AND ue.ledger_type NOT IN ('CLAWBACK', 'SETTLE_ADJUST', 'ADMIN_ADJUST')
    AND strpos(v.uniq_key, ':REASSIGN_REV:') = 0
),
stats AS (
  SELECT count(*) AS checked_rows FROM user_entries
)
SELECT
  '07'::text AS invariant,
  st.checked_rows,
  'account'::text AS scope,
  df.app_id,
  df.account_id,
  df.detail
FROM differences df
CROSS JOIN stats st
UNION ALL
SELECT
  '07'::text AS invariant,
  st.checked_rows,
  'none'::text AS scope,
  NULL::text AS app_id,
  NULL::uuid AS account_id,
  NULL::jsonb AS detail
FROM stats st
WHERE NOT EXISTS (SELECT 1 FROM differences)
ORDER BY app_id, account_id, detail
