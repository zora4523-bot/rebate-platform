-- BR-FUND-19 ③ 全局（红冲版）：每个 (子订单, 受益人, 角色) 的有效 CREDIT 凭证 ≤ 1。
-- 任务 B2-02l。替代 03_credit-unique.sql（登记在 superseded.json，日终运行器跳过旧文件）。
-- 替代原因：BR-FUND-16 的更正写红冲凭证（沿用原 voucher_kind，uniq_key = 原 uniq_key || ':REVERSE'）
-- 再重记；旧 03 按 CREDIT 张数计，会把「原单 + 红冲」数成两张而报假差异。db/invariants 只增不改，
-- 所以新增本文件，输出列 invariant 仍为 '03'，checked_rows 与旧 03 同口径。
-- 只读，一条 SELECT，检查全量（不按会计日过滤，与旧 03 一致）。
--
-- 口径
-- - 归集只用凭证结构化列（ledger-plan D3 A）：app_id、order_key、beneficiary_user_id、role，
--   只看 voucher_kind = CREDIT；CLAWBACK、SETTLE_ADJUST 等其他类型不受本条约束。结构化列任一为空
--   的凭证不构成受益人键，不参与。
-- - 红冲凭证：uniq_key 以 ':REVERSE' 结尾（用 right / left 精确比较，不用 LIKE，键里的 % 与 _
--   都是普通字符；键中间出现 REVERSE 不算）。红冲凭证本身不算入账。
-- - 配对：红冲凭证的原凭证 = 同 app_id、同 order_key、同受益人、同角色、voucher_kind = CREDIT、
--   本身不是红冲、uniq_key 恰为红冲键去掉末尾 ':REVERSE' 的凭证；任一结构化列不同都不配对。
-- - 有效入账 = 不是红冲、且同键下找不到其红冲凭证的 CREDIT 凭证。同键有效入账多于 1 张报差异。
-- - 孤立红冲 = 同键下找不到原凭证的红冲凭证（含原凭证本身也是红冲的情形），报差异。
-- - 数的是凭证张数，不是分录条数；金额是否等额由 04 复核，本条不看金额。
-- - checked_rows = 参与核对的 (app_id, 子订单, 受益人, 角色) 键数（与旧 03 相同：只要键下有
--   CREDIT 凭证就计 1，原单与其红冲同属一个键）。
WITH credit_vouchers AS (
  SELECT
    v.app_id,
    v.id,
    v.uniq_key,
    v.order_key,
    v.beneficiary_user_id,
    v.role,
    (right(v.uniq_key, 8) = ':REVERSE') AS is_reversal
  FROM app.ledger_vouchers v
  WHERE v.voucher_kind = 'CREDIT'
    AND v.order_key IS NOT NULL
    AND v.beneficiary_user_id IS NOT NULL
    AND v.role IS NOT NULL
),
classified AS (
  SELECT
    cv.app_id,
    cv.id,
    cv.uniq_key,
    cv.order_key,
    cv.beneficiary_user_id,
    cv.role,
    cv.is_reversal,
    (
      NOT cv.is_reversal
      AND NOT EXISTS (
        SELECT 1
        FROM app.ledger_vouchers r
        WHERE r.app_id = cv.app_id
          AND r.uniq_key = cv.uniq_key || ':REVERSE'
          AND r.voucher_kind = 'CREDIT'
          AND r.order_key = cv.order_key
          AND r.beneficiary_user_id = cv.beneficiary_user_id
          AND r.role = cv.role
      )
    ) AS is_effective,
    (
      cv.is_reversal
      AND NOT EXISTS (
        SELECT 1
        FROM app.ledger_vouchers o
        WHERE o.app_id = cv.app_id
          AND o.uniq_key = left(cv.uniq_key, -8)
          AND right(o.uniq_key, 8) <> ':REVERSE'
          AND o.voucher_kind = 'CREDIT'
          AND o.order_key = cv.order_key
          AND o.beneficiary_user_id = cv.beneficiary_user_id
          AND o.role = cv.role
      )
    ) AS is_orphan_reversal
  FROM credit_vouchers cv
),
credit_keys AS (
  SELECT
    c.app_id,
    c.order_key,
    c.beneficiary_user_id,
    c.role,
    count(*) AS credit_vouchers,
    count(*) FILTER (WHERE c.is_reversal) AS reversal_vouchers,
    count(*) FILTER (WHERE c.is_effective) AS effective_credits,
    count(*) FILTER (WHERE c.is_orphan_reversal) AS orphan_reversals,
    jsonb_agg(c.id::text ORDER BY c.id) AS voucher_ids,
    jsonb_agg(c.uniq_key ORDER BY c.id) AS uniq_keys,
    COALESCE(
      jsonb_agg(c.uniq_key ORDER BY c.id) FILTER (WHERE c.is_effective),
      '[]'::jsonb
    ) AS effective_uniq_keys,
    COALESCE(
      jsonb_agg(c.uniq_key ORDER BY c.id) FILTER (WHERE c.is_orphan_reversal),
      '[]'::jsonb
    ) AS orphan_reversal_uniq_keys
  FROM classified c
  GROUP BY c.app_id, c.order_key, c.beneficiary_user_id, c.role
),
differences AS (
  SELECT
    ck.app_id,
    jsonb_build_object(
      'order_key', ck.order_key,
      'beneficiary_user_id', ck.beneficiary_user_id::text,
      'role', ck.role,
      'max_effective_credits', '1',
      'effective_credits', ck.effective_credits::text,
      'orphan_reversals', ck.orphan_reversals::text,
      'credit_vouchers', ck.credit_vouchers::text,
      'reversal_vouchers', ck.reversal_vouchers::text,
      'voucher_ids', ck.voucher_ids,
      'uniq_keys', ck.uniq_keys,
      'effective_uniq_keys', ck.effective_uniq_keys,
      'orphan_reversal_uniq_keys', ck.orphan_reversal_uniq_keys
    ) AS detail
  FROM credit_keys ck
  WHERE ck.effective_credits > 1
    OR ck.orphan_reversals > 0
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
