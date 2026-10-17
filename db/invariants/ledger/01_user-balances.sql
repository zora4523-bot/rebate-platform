-- BR-FUND-19 ① 账户级：每个用户账户 余额缓存 = 分录合计，且 期初 + 当日发生额 = 期末（daily_balances）。
-- 任务 B2-02e。只读，一条 SELECT。会计日由运行器经 couli.check_date 传入（只用于日余额那一半）。
--
-- 口径
-- - 用户账户：ledger_accounts.owner_type = user（每个用户一个 USER_BALANCE 账户），平台账户不参与。
-- - 分录是分录口径（借正贷负），用户口径余额 = 分录合计的相反数：
--   account_balances.available_fen = 0 - Σ available 分录，frozen_fen = 0 - Σ frozen 分录，
--   按 available、frozen 分子户各自核对（总额相同但错位也报）。缓存核对用全部分录（缓存是当前值）。
-- - 有分录却没有缓存行的账户按差异报出（不靠内连接静默丢弃）。
-- - daily_balances 也是分录口径（decision 20）：只取 accounting_date = 校验日、属于用户账户的行，
--   核对 opening_fen + debit_fen - credit_fen = closing_fen，available 与 frozen 两个子户都核对。
-- - 金额只做整数加减比较：sum(bigint) 是 numeric，精确，不用浮点。detail 里的金额写成文本，
--   避免 JSON 数字在 2^53 以上丢精度。
-- - checked_rows = 用户账户数 × 2 个子户（缓存核对）+ 校验日的用户日余额行数。
WITH params AS (
  SELECT current_setting('couli.check_date')::date AS check_date
),
user_accounts AS (
  SELECT a.app_id, a.id AS account_id
  FROM app.ledger_accounts a
  WHERE a.owner_type = 'user'
),
sub_accounts AS (
  SELECT s.sub_account
  FROM (VALUES ('available'::text), ('frozen'::text)) AS s (sub_account)
),
entry_sums AS (
  SELECT e.app_id, e.account_id, e.sub_account, sum(e.amount_fen) AS entries_fen
  FROM app.ledger_entries e
  JOIN user_accounts ua ON ua.app_id = e.app_id AND ua.account_id = e.account_id
  GROUP BY e.app_id, e.account_id, e.sub_account
),
entry_counts AS (
  SELECT e.app_id, e.account_id, count(*) AS entry_count
  FROM app.ledger_entries e
  JOIN user_accounts ua ON ua.app_id = e.app_id AND ua.account_id = e.account_id
  GROUP BY e.app_id, e.account_id
),
cache_checks AS (
  SELECT
    ua.app_id,
    ua.account_id,
    s.sub_account,
    b.account_id IS NOT NULL AS has_cache,
    CASE s.sub_account WHEN 'available' THEN b.available_fen ELSE b.frozen_fen END AS cache_fen,
    COALESCE(es.entries_fen, 0) AS entries_fen,
    0 - COALESCE(es.entries_fen, 0) AS expected_fen,
    COALESCE(ec.entry_count, 0) AS entry_count
  FROM user_accounts ua
  CROSS JOIN sub_accounts s
  LEFT JOIN app.account_balances b
    ON b.app_id = ua.app_id AND b.account_id = ua.account_id
  LEFT JOIN entry_sums es
    ON es.app_id = ua.app_id AND es.account_id = ua.account_id AND es.sub_account = s.sub_account
  LEFT JOIN entry_counts ec
    ON ec.app_id = ua.app_id AND ec.account_id = ua.account_id
),
daily_checks AS (
  SELECT
    d.app_id,
    d.account_id,
    d.sub_account,
    d.accounting_date,
    d.opening_fen,
    d.debit_fen,
    d.credit_fen,
    d.closing_fen,
    d.opening_fen::numeric + d.debit_fen::numeric - d.credit_fen::numeric AS expected_closing_fen
  FROM app.daily_balances d
  JOIN user_accounts ua ON ua.app_id = d.app_id AND ua.account_id = d.account_id
  CROSS JOIN params p
  WHERE d.accounting_date = p.check_date
),
differences AS (
  SELECT
    c.app_id,
    c.account_id,
    jsonb_build_object(
      'check', 'balance_cache',
      'sub_account', c.sub_account,
      'cache_present', c.has_cache,
      'cache_fen', c.cache_fen::text,
      'expected_cache_fen', c.expected_fen::text,
      'entries_sum_fen', c.entries_fen::text
    ) AS detail
  FROM cache_checks c
  WHERE (NOT c.has_cache AND c.entry_count > 0)
    OR (c.has_cache AND c.cache_fen::numeric <> c.expected_fen)
  UNION ALL
  SELECT
    dc.app_id,
    dc.account_id,
    jsonb_build_object(
      'check', 'daily_balance',
      'sub_account', dc.sub_account,
      'accounting_date', dc.accounting_date::text,
      'opening_fen', dc.opening_fen::text,
      'debit_fen', dc.debit_fen::text,
      'credit_fen', dc.credit_fen::text,
      'closing_fen', dc.closing_fen::text,
      'expected_closing_fen', dc.expected_closing_fen::text
    ) AS detail
  FROM daily_checks dc
  WHERE dc.closing_fen::numeric <> dc.expected_closing_fen
),
stats AS (
  SELECT (SELECT count(*) FROM cache_checks) + (SELECT count(*) FROM daily_checks) AS checked_rows
)
SELECT
  '01'::text AS invariant,
  st.checked_rows,
  'account'::text AS scope,
  df.app_id,
  df.account_id,
  df.detail
FROM differences df
CROSS JOIN stats st
UNION ALL
SELECT
  '01'::text AS invariant,
  st.checked_rows,
  'none'::text AS scope,
  NULL::text AS app_id,
  NULL::uuid AS account_id,
  NULL::jsonb AS detail
FROM stats st
WHERE NOT EXISTS (SELECT 1 FROM differences)
ORDER BY app_id, account_id, detail
