-- B2-05b / BR-FUND-14：用户冻结余额等于非终态提现申请金额之和。
-- 规则测试资产；只读一条 SELECT，不依赖 SQL 时钟，不触发冻结或记账。
-- checked_rows 为用户账户数（含无提现及缺余额行的账户）；平台账户不参与。
-- 缺余额且有在途单必须报差异，不能被内连接或 NULL 比较漏掉。
-- sum(bigint) 返回精确 numeric；detail 金额转文本，不经浮点数。
WITH user_accounts AS (
  SELECT app_id, id AS account_id, owner_id
  FROM app.ledger_accounts
  WHERE owner_type = 'user'
),
open_withdrawals AS (
  SELECT app_id, user_id::text AS owner_id, sum(amount_fen) AS amount_fen
  FROM app.withdrawals
  WHERE status IN ('PENDING_REVIEW', 'APPROVED', 'PAYING')
  GROUP BY app_id, user_id
),
differences AS (
  SELECT a.app_id, a.account_id,
    jsonb_build_object(
      'user_id', a.owner_id,
      'balance_present', b.account_id IS NOT NULL,
      'frozen_fen', b.frozen_fen::text,
      'open_amount_fen', COALESCE(w.amount_fen, 0)::text
    ) AS detail
  FROM user_accounts a
  LEFT JOIN app.account_balances b ON b.app_id = a.app_id AND b.account_id = a.account_id
  LEFT JOIN open_withdrawals w ON w.app_id = a.app_id AND w.owner_id = a.owner_id
  WHERE (b.account_id IS NULL AND w.owner_id IS NOT NULL)
    OR (b.account_id IS NOT NULL AND b.frozen_fen::numeric <> COALESCE(w.amount_fen, 0))
),
stats AS (
  SELECT count(*) AS checked_rows FROM user_accounts
)
SELECT '06'::text AS invariant, s.checked_rows, 'account'::text AS scope,
  d.app_id, d.account_id, d.detail
FROM differences d CROSS JOIN stats s
UNION ALL
SELECT '06'::text AS invariant, s.checked_rows, 'none'::text AS scope,
  NULL::text AS app_id, NULL::uuid AS account_id, NULL::jsonb AS detail
FROM stats s
WHERE NOT EXISTS (SELECT 1 FROM differences)
ORDER BY app_id, account_id;
