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
-- - 抵消：只有配对且实际抵消的原凭证才从有效入账中排除。实际抵消 = 原凭证与红冲凭证的全部分录
--   按 (账户, 子户, ledger_type, sub_type) 分项相加，每一项都为 0，且红冲凭证没有原凭证里不存在
--   的分录项（BR-FUND-16 红冲模板沿用原单 ledger_type / sub_type、借贷相反）。金额用 sum(bigint)
--   = numeric，精确。
-- - 有效入账 = 不是红冲、且没有被实际抵消的 CREDIT 凭证（配对但未抵消的原凭证仍算有效入账）。
-- - 差异（每个键至多一行 global，detail.reasons 写明原因，可同时有多条）：
--   a) multiple_effective_credits：同键有效入账多于 1 张；
--   b) orphan_reversal：同键下有找不到原凭证的红冲凭证（含原凭证本身也是红冲的情形）；
--   c) reversal_not_offsetting：配对存在但未完全抵消（有残留金额的分录项，或红冲有原单以外的
--      分录项），detail.unoffset_pairs 列出每对的残留项数与多出项数。
-- - 数的是凭证张数，不是分录条数（一张凭证可有 available、frozen 等多条分录）。
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
pairs AS (
  SELECT
    o.app_id,
    o.id AS original_id,
    o.uniq_key AS original_uniq_key,
    r.id AS reversal_id,
    r.uniq_key AS reversal_uniq_key
  FROM credit_vouchers o
  JOIN credit_vouchers r
    ON r.app_id = o.app_id
    AND r.is_reversal
    AND left(r.uniq_key, -8) = o.uniq_key
    AND r.order_key = o.order_key
    AND r.beneficiary_user_id = o.beneficiary_user_id
    AND r.role = o.role
  WHERE NOT o.is_reversal
),
pair_lines AS (
  SELECT
    p.app_id,
    p.original_id,
    e.account_id,
    e.sub_account,
    e.ledger_type,
    e.sub_type,
    sum(e.amount_fen) AS net_fen,
    bool_or(e.voucher_id = p.original_id) AS in_original
  FROM pairs p
  JOIN app.ledger_entries e
    ON e.app_id = p.app_id
    AND (e.voucher_id = p.original_id OR e.voucher_id = p.reversal_id)
  GROUP BY p.app_id, p.original_id, e.account_id, e.sub_account, e.ledger_type, e.sub_type
),
pair_checks AS (
  SELECT
    p.app_id,
    p.original_id,
    p.reversal_id,
    p.original_uniq_key,
    p.reversal_uniq_key,
    count(l.account_id) FILTER (WHERE l.net_fen <> 0) AS residual_lines,
    count(l.account_id) FILTER (WHERE NOT l.in_original) AS extra_reversal_lines
  FROM pairs p
  LEFT JOIN pair_lines l
    ON l.app_id = p.app_id
    AND l.original_id = p.original_id
  GROUP BY p.app_id, p.original_id, p.reversal_id, p.original_uniq_key, p.reversal_uniq_key
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
      AND (
        po.original_id IS NULL
        OR po.residual_lines > 0
        OR po.extra_reversal_lines > 0
      )
    ) AS is_effective,
    (
      po.original_id IS NOT NULL
      AND (po.residual_lines > 0 OR po.extra_reversal_lines > 0)
    ) AS is_unoffset_original,
    (cv.is_reversal AND pr.reversal_id IS NULL) AS is_orphan_reversal,
    po.reversal_uniq_key,
    po.residual_lines,
    po.extra_reversal_lines
  FROM credit_vouchers cv
  LEFT JOIN pair_checks po
    ON po.app_id = cv.app_id
    AND po.original_id = cv.id
  LEFT JOIN pairs pr
    ON pr.app_id = cv.app_id
    AND pr.reversal_id = cv.id
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
    count(*) FILTER (WHERE c.is_unoffset_original) AS unoffset_pairs,
    jsonb_agg(c.id::text ORDER BY c.id) AS voucher_ids,
    jsonb_agg(c.uniq_key ORDER BY c.id) AS uniq_keys,
    COALESCE(
      jsonb_agg(c.uniq_key ORDER BY c.id) FILTER (WHERE c.is_effective),
      '[]'::jsonb
    ) AS effective_uniq_keys,
    COALESCE(
      jsonb_agg(c.uniq_key ORDER BY c.id) FILTER (WHERE c.is_orphan_reversal),
      '[]'::jsonb
    ) AS orphan_reversal_uniq_keys,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'original_uniq_key', c.uniq_key,
          'reversal_uniq_key', c.reversal_uniq_key,
          'residual_lines', c.residual_lines::text,
          'extra_reversal_lines', c.extra_reversal_lines::text
        )
        ORDER BY c.id
      ) FILTER (WHERE c.is_unoffset_original),
      '[]'::jsonb
    ) AS unoffset_pair_details
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
      'reasons', (
        SELECT COALESCE(jsonb_agg(reason.label ORDER BY reason.ord), '[]'::jsonb)
        FROM (
          VALUES
            (1, 'multiple_effective_credits', ck.effective_credits > 1),
            (2, 'orphan_reversal', ck.orphan_reversals > 0),
            (3, 'reversal_not_offsetting', ck.unoffset_pairs > 0)
        ) AS reason (ord, label, hit)
        WHERE reason.hit
      ),
      'max_effective_credits', '1',
      'effective_credits', ck.effective_credits::text,
      'orphan_reversals', ck.orphan_reversals::text,
      'unoffset_pairs', ck.unoffset_pairs::text,
      'credit_vouchers', ck.credit_vouchers::text,
      'reversal_vouchers', ck.reversal_vouchers::text,
      'voucher_ids', ck.voucher_ids,
      'uniq_keys', ck.uniq_keys,
      'effective_uniq_keys', ck.effective_uniq_keys,
      'orphan_reversal_uniq_keys', ck.orphan_reversal_uniq_keys,
      'unoffset_pair_details', ck.unoffset_pair_details
    ) AS detail
  FROM credit_keys ck
  WHERE ck.effective_credits > 1
    OR ck.orphan_reversals > 0
    OR ck.unoffset_pairs > 0
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
