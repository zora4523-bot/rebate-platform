-- BR-FUND-19 ④ 全局：每个 (子订单, 受益人, 角色) 的净额 ≥ 0。
-- 净额 = 该受益人键下 CREDIT、SETTLE_ADJUST、CLAWBACK、ADMIN_ADJUST RESTORE、REASSIGN_REV、
-- REASSIGN_CREDIT 的代数和（改记平台坏账的扣回计入，归平台的正差不计入）。
-- 任务 B2-02e。只读，一条 SELECT，检查全量历史（不按会计日过滤）。
--
-- 口径
-- - 受益人键只用凭证结构化列（ledger-plan D3 A）：app_id、order_key、beneficiary_user_id、role；
--   三列任一为空的凭证不构成键。参与的凭证按 voucher_kind 取上面六类；ADMIN_ADJUST 只取
--   含 sub_type = RESTORE 分录的凭证（RECON_FIX 等其他调账不计入），REWARD 等其他类型不计入。
-- - 每张参与凭证对净额的贡献 = 0 - Σ(该凭证落在下面两类账户上的分录 amount_fen)：
--   a) 受益人本人的用户账户（同 app_id，owner_type = user，owner_id = beneficiary_user_id），
--      available 与 frozen 两个子户都算：贷记用户（负数）使净额增加，借记用户（正数）使净额减少；
--   b) 平台坏账科目（subject 为 BAD_DEBT 或 BAD_DEBT:<后缀>）：扣回改记坏账时借记坏账，同样减少净额。
--   归平台的部分（COMMISSION_REVENUE 等）与 UNION_RECEIVABLE 对方分录不计入，所以归平台的正差
--   不会掩盖过扣。
-- - 金额用 sum(bigint) = numeric，精确；detail 里的金额写成文本，避免 JSON 数字丢精度。
-- - checked_rows = 参与核对的 (app_id, 子订单, 受益人, 角色) 键数。
WITH keyed_vouchers AS (
  SELECT v.app_id, v.id AS voucher_id, v.order_key, v.beneficiary_user_id, v.role, v.voucher_kind
  FROM app.ledger_vouchers v
  WHERE v.order_key IS NOT NULL
    AND v.beneficiary_user_id IS NOT NULL
    AND v.role IS NOT NULL
    AND (
      v.voucher_kind IN ('CREDIT', 'SETTLE_ADJUST', 'CLAWBACK', 'REASSIGN_REV', 'REASSIGN_CREDIT')
      OR (
        v.voucher_kind = 'ADMIN_ADJUST'
        AND EXISTS (
          SELECT 1
          FROM app.ledger_entries r
          WHERE r.app_id = v.app_id
            AND r.voucher_id = v.id
            AND r.ledger_type = 'ADMIN_ADJUST'
            AND r.sub_type = 'RESTORE'
        )
      )
    )
),
contributions AS (
  SELECT
    kv.app_id,
    kv.voucher_id,
    kv.order_key,
    kv.beneficiary_user_id,
    kv.role,
    0 - COALESCE(sum(e.amount_fen), 0) AS net_fen
  FROM keyed_vouchers kv
  LEFT JOIN app.ledger_entries e
    ON e.app_id = kv.app_id
    AND e.voucher_id = kv.voucher_id
    AND EXISTS (
      SELECT 1
      FROM app.ledger_accounts a
      WHERE a.app_id = e.app_id
        AND a.id = e.account_id
        AND (
          (a.owner_type = 'user' AND a.owner_id = kv.beneficiary_user_id::text)
          OR (
            a.owner_type = 'platform'
            AND (a.subject = 'BAD_DEBT' OR left(a.subject, 9) = 'BAD_DEBT:')
          )
        )
    )
  GROUP BY kv.app_id, kv.voucher_id, kv.order_key, kv.beneficiary_user_id, kv.role
),
beneficiary_nets AS (
  SELECT
    c.app_id,
    c.order_key,
    c.beneficiary_user_id,
    c.role,
    sum(c.net_fen) AS net_fen,
    count(*) AS vouchers,
    jsonb_agg(c.voucher_id::text ORDER BY c.voucher_id) AS voucher_ids
  FROM contributions c
  GROUP BY c.app_id, c.order_key, c.beneficiary_user_id, c.role
),
differences AS (
  SELECT
    bn.app_id,
    jsonb_build_object(
      'order_key', bn.order_key,
      'beneficiary_user_id', bn.beneficiary_user_id::text,
      'role', bn.role,
      'min_net_fen', '0',
      'net_fen', bn.net_fen::text,
      'vouchers', bn.vouchers::text,
      'voucher_ids', bn.voucher_ids
    ) AS detail
  FROM beneficiary_nets bn
  WHERE bn.net_fen < 0
),
stats AS (
  SELECT count(*) AS checked_rows FROM beneficiary_nets
)
SELECT
  '04'::text AS invariant,
  st.checked_rows,
  'global'::text AS scope,
  df.app_id,
  NULL::uuid AS account_id,
  df.detail
FROM differences df
CROSS JOIN stats st
UNION ALL
SELECT
  '04'::text AS invariant,
  st.checked_rows,
  'none'::text AS scope,
  NULL::text AS app_id,
  NULL::uuid AS account_id,
  NULL::jsonb AS detail
FROM stats st
WHERE NOT EXISTS (SELECT 1 FROM differences)
ORDER BY app_id, detail
