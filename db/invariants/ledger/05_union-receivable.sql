-- BR-FUND-19 ⑤ 全局：每个 CREDITED 或 CLAWED_BACK 子订单，订单类凭证对 UNION_RECEIVABLE 的净额
-- = booked_n_fen − Σ 待补记额，且 Σ 受益人净额 ≤ booked_base_fen。
-- 任务 B2-04z。只读，一条 SELECT。由 ledger 日终运行器按目录执行；读 orders、beneficiary_credits、
-- commission_splits 等跨模块表是 BR-FUND-19 日终复核本意（编排 S13 唯一例外，只读）。
--
-- 口径
-- - 候选：app.orders 中 rebate_status ∈ {CREDITED, CLAWED_BACK} 的子订单；子订单键 order_key =
--   platform || ':' || sub_order_id，凭证按 (app_id, order_key) 精确归集（ledger-plan D3 A，
--   与 ledger 的 getOrderNets 端口同口径），不看 uniq_key、biz_id、memo。
--   缺任何凭证的候选也照样核对（应收净额按 0），不靠内连接静默丢弃。
-- - 不按会计日截断：booked_n_fen / booked_base_fen 只有当前值、没有历史快照（细则未定义），
--   所以订单与凭证都取运行器同一只读快照里的全部数据。若只算会计日 ≤ 核对日的凭证却拿当前
--   booked 比，01:00 核对 D−1 时 00:00–01:00 已提交的调整凭证（会计日 D）会造成假差异；
--   同一快照两边口径一致，少记一分仍报出。核对日 couli.check_date 因此不参与本条。
-- - 订单类凭证：voucher_kind ∈ {CREDIT, FORFEIT, CLAWBACK, SETTLE_ADJUST, REASSIGN_REV,
--   REASSIGN_CREDIT}，以及含 ledger_type = ADMIN_ADJUST 且 sub_type = RESTORE 分录的 ADMIN_ADJUST
--   凭证（RECON_FIX 等其他调账、REWARD、UNION_RECEIPT 等不计入）；含无受益人键的平台级凭证。
-- - 应收净额 = Σ 这些凭证落在平台 UNION_RECEIVABLE 科目（subject 为 UNION_RECEIVABLE 或
--   UNION_RECEIVABLE:<后缀>）上的分录 amount_fen（分录口径借正贷负，即借方净额）。对方是其他科目
--   （如 CASH）的分录不计入。
-- - 受益人净额：与 04 同口径。键 = 凭证结构化列 (beneficiary_user_id, role)，三列任一为空不构成键；
--   只取 CREDIT、SETTLE_ADJUST、CLAWBACK、REASSIGN_REV、REASSIGN_CREDIT 与 ADMIN_ADJUST RESTORE
--   （FORFEIT 不计入受益人）；每张凭证贡献 0 − Σ(落在受益人本人用户账户 available / frozen 与
--   平台坏账科目 BAD_DEBT[:<后缀>] 上的分录)。改记坏账的扣回计入，归平台的正差不计入。
-- - Σ 受益人净额上限：按键先求净额，再对 max(净额, 0) 求和后与 booked_base_fen 比较。负净额已由
--   ④ 报出；不让某键的负净额抵掉另一键的超额（否则超额收款人不会被定位、提现不会被冻结）。
--   detail 同时给出代数和。
-- - 待补记额（BR-FUND-04 ⑫）：只算有未完成义务的受益人键——同 app_id、同 order_id、同 (user_id,
--   role) 存在 status = open 的 beneficiary_credits（first_credit / deferred / reassign_credit 均算；
--   同键多条 open 只计一次；done、forfeited、voided 已关闭，不再计入；快照里 initial_status = held
--   本身不构成义务）。剩余未履约金额 = max(应得 − 该键净额, 0)，应得 = floor(booked_base_fen ×
--   ratio_bp / 10000)，ratio_bp 取 commission_splits.beneficiaries 快照中同 (user_id, role) 的项；
--   按键各自截零后再求和，一个键的超额不能抵另一个键的缺口。
-- - 快照中找不到该键、同键出现多于一项、ratio_bp 不是数字或 booked 值为空时，待补记额无法确定，
--   按差异报出（detail.reasons 含 pending_unresolved / booked_missing），不当作 0 放过。
-- - 金额全部用 numeric 精确计算（sum(bigint) 即 numeric；乘比例先转 numeric，div 取整，不经浮点、
--   不溢出 bigint）；detail 里金额写成文本，避免 JSON 数字在 2^53 以上丢精度。
-- - 差异（每个子订单至多一行 global，detail.reasons 列出原因）：
--   a) receivable_mismatch：应收净额 ≠ booked_n_fen − Σ 待补记额；
--   b) beneficiary_net_exceeds_base：Σ max(受益人净额, 0) > booked_base_fen；
--   c) pending_unresolved：有 open 义务的键无法从快照确定比例；
--   d) booked_missing：booked_n_fen 或 booked_base_fen 为空。
-- - checked_rows = 候选子订单数（不被凭证、义务、分录连接倍增）。
WITH candidates AS (
  SELECT
    o.app_id,
    o.order_id,
    o.platform || ':' || o.sub_order_id AS order_key,
    o.rebate_status,
    o.booked_n_fen,
    o.booked_base_fen
  FROM app.orders o
  WHERE o.rebate_status IN ('CREDITED', 'CLAWED_BACK')
),
order_vouchers AS (
  SELECT
    c.app_id,
    c.order_id,
    v.id AS voucher_id,
    v.voucher_kind,
    v.beneficiary_user_id,
    v.role,
    (
      v.voucher_kind = 'ADMIN_ADJUST'
      AND EXISTS (
        SELECT 1
        FROM app.ledger_entries r
        WHERE r.app_id = v.app_id
          AND r.voucher_id = v.id
          AND r.ledger_type = 'ADMIN_ADJUST'
          AND r.sub_type = 'RESTORE'
      )
    ) AS is_restore
  FROM candidates c
  JOIN app.ledger_vouchers v
    ON v.app_id = c.app_id
    AND v.order_key = c.order_key
),
classified_vouchers AS (
  SELECT
    ov.app_id,
    ov.order_id,
    ov.voucher_id,
    ov.beneficiary_user_id,
    ov.role,
    (
      ov.voucher_kind IN ('CREDIT', 'SETTLE_ADJUST', 'CLAWBACK', 'REASSIGN_REV', 'REASSIGN_CREDIT')
      OR ov.is_restore
    ) AS beneficiary_kind,
    (
      ov.voucher_kind IN (
        'CREDIT', 'FORFEIT', 'SETTLE_ADJUST', 'CLAWBACK', 'REASSIGN_REV', 'REASSIGN_CREDIT'
      )
      OR ov.is_restore
    ) AS receivable_kind
  FROM order_vouchers ov
),
receivables AS (
  SELECT
    cv.app_id,
    cv.order_id,
    sum(e.amount_fen) AS receivable_net_fen
  FROM classified_vouchers cv
  JOIN app.ledger_entries e
    ON e.app_id = cv.app_id
    AND e.voucher_id = cv.voucher_id
  JOIN app.ledger_accounts a
    ON a.app_id = e.app_id
    AND a.id = e.account_id
  WHERE cv.receivable_kind
    AND a.owner_type = 'platform'
    AND (a.subject = 'UNION_RECEIVABLE' OR left(a.subject, 17) = 'UNION_RECEIVABLE:')
  GROUP BY cv.app_id, cv.order_id
),
contributions AS (
  SELECT
    cv.app_id,
    cv.order_id,
    cv.voucher_id,
    cv.beneficiary_user_id,
    cv.role,
    0 - COALESCE(
      sum(e.amount_fen) FILTER (
        WHERE (a.owner_type = 'user' AND a.owner_id = cv.beneficiary_user_id::text)
          OR (
            a.owner_type = 'platform'
            AND (a.subject = 'BAD_DEBT' OR left(a.subject, 9) = 'BAD_DEBT:')
          )
      ),
      0
    ) AS net_fen
  FROM classified_vouchers cv
  LEFT JOIN app.ledger_entries e
    ON e.app_id = cv.app_id
    AND e.voucher_id = cv.voucher_id
  LEFT JOIN app.ledger_accounts a
    ON a.app_id = e.app_id
    AND a.id = e.account_id
  WHERE cv.beneficiary_kind
    AND cv.beneficiary_user_id IS NOT NULL
    AND cv.role IS NOT NULL
  GROUP BY cv.app_id, cv.order_id, cv.voucher_id, cv.beneficiary_user_id, cv.role
),
beneficiary_nets AS (
  SELECT
    c.app_id,
    c.order_id,
    c.beneficiary_user_id,
    c.role,
    sum(c.net_fen) AS net_fen
  FROM contributions c
  GROUP BY c.app_id, c.order_id, c.beneficiary_user_id, c.role
),
net_totals AS (
  SELECT
    bn.app_id,
    bn.order_id,
    sum(greatest(bn.net_fen, 0)) AS positive_net_sum_fen,
    sum(bn.net_fen) AS net_sum_fen,
    count(*) AS beneficiary_keys
  FROM beneficiary_nets bn
  GROUP BY bn.app_id, bn.order_id
),
open_keys AS (
  SELECT DISTINCT
    bc.app_id,
    bc.order_id,
    bc.user_id,
    bc.role
  FROM candidates c
  JOIN app.beneficiary_credits bc
    ON bc.app_id = c.app_id
    AND bc.order_id = c.order_id
  WHERE bc.status = 'open'
),
key_ratios AS (
  SELECT
    ok.app_id,
    ok.order_id,
    ok.user_id,
    ok.role,
    count(b.item) AS snapshot_items,
    count(b.item) FILTER (WHERE jsonb_typeof(b.item -> 'ratio_bp') = 'number') AS numeric_ratios,
    min(
      CASE WHEN jsonb_typeof(b.item -> 'ratio_bp') = 'number' THEN (b.item ->> 'ratio_bp')::numeric END
    ) AS ratio_bp
  FROM open_keys ok
  LEFT JOIN app.commission_splits s
    ON s.app_id = ok.app_id
    AND s.order_id = ok.order_id
  LEFT JOIN LATERAL jsonb_array_elements(s.beneficiaries) AS b (item)
    ON lower(b.item ->> 'user_id') = ok.user_id::text
    AND b.item ->> 'role' = ok.role
  GROUP BY ok.app_id, ok.order_id, ok.user_id, ok.role
),
pending_items AS (
  SELECT
    kr.app_id,
    kr.order_id,
    kr.user_id,
    kr.role,
    kr.ratio_bp,
    COALESCE(bn.net_fen, 0) AS net_fen,
    CASE
      WHEN kr.snapshot_items = 1 AND kr.numeric_ratios = 1 AND c.booked_base_fen IS NOT NULL
        THEN div(c.booked_base_fen::numeric * kr.ratio_bp, 10000)
    END AS entitled_fen
  FROM key_ratios kr
  JOIN candidates c
    ON c.app_id = kr.app_id
    AND c.order_id = kr.order_id
  LEFT JOIN beneficiary_nets bn
    ON bn.app_id = kr.app_id
    AND bn.order_id = kr.order_id
    AND bn.beneficiary_user_id = kr.user_id
    AND bn.role = kr.role
),
pending_totals AS (
  SELECT
    pi.app_id,
    pi.order_id,
    COALESCE(sum(greatest(pi.entitled_fen - pi.net_fen, 0)), 0) AS pending_fen,
    bool_or(pi.entitled_fen IS NULL) AS unresolved,
    jsonb_agg(
      jsonb_build_object(
        'user_id', pi.user_id::text,
        'role', pi.role,
        'ratio_bp', pi.ratio_bp::text,
        'entitled_fen', pi.entitled_fen::text,
        'net_fen', pi.net_fen::text,
        'pending_fen', greatest(pi.entitled_fen - pi.net_fen, 0)::text
      )
      ORDER BY pi.user_id, pi.role
    ) AS items
  FROM pending_items pi
  GROUP BY pi.app_id, pi.order_id
),
checks AS (
  SELECT
    c.app_id,
    c.order_id,
    c.order_key,
    c.rebate_status,
    c.booked_n_fen,
    c.booked_base_fen,
    COALESCE(r.receivable_net_fen, 0) AS receivable_net_fen,
    COALESCE(pt.pending_fen, 0) AS pending_fen,
    c.booked_n_fen::numeric - COALESCE(pt.pending_fen, 0) AS expected_receivable_fen,
    COALESCE(nt.positive_net_sum_fen, 0) AS positive_net_sum_fen,
    COALESCE(nt.net_sum_fen, 0) AS net_sum_fen,
    COALESCE(nt.beneficiary_keys, 0) AS beneficiary_keys,
    COALESCE(pt.unresolved, false) AS unresolved,
    COALESCE(pt.items, '[]'::jsonb) AS pending_items
  FROM candidates c
  LEFT JOIN receivables r
    ON r.app_id = c.app_id
    AND r.order_id = c.order_id
  LEFT JOIN net_totals nt
    ON nt.app_id = c.app_id
    AND nt.order_id = c.order_id
  LEFT JOIN pending_totals pt
    ON pt.app_id = c.app_id
    AND pt.order_id = c.order_id
),
flagged AS (
  SELECT
    ch.*,
    (ch.booked_n_fen IS NULL OR ch.booked_base_fen IS NULL) AS booked_missing,
    (
      ch.booked_n_fen IS NOT NULL
      AND NOT ch.unresolved
      AND ch.receivable_net_fen <> ch.expected_receivable_fen
    ) AS receivable_mismatch,
    (
      ch.booked_base_fen IS NOT NULL
      AND ch.positive_net_sum_fen > ch.booked_base_fen::numeric
    ) AS net_exceeds_base
  FROM checks ch
),
differences AS (
  SELECT
    f.app_id,
    jsonb_build_object(
      'order_id', f.order_id::text,
      'order_key', f.order_key,
      'rebate_status', f.rebate_status,
      'reasons', (
        SELECT COALESCE(jsonb_agg(reason.label ORDER BY reason.ord), '[]'::jsonb)
        FROM (
          VALUES
            (1, 'receivable_mismatch', f.receivable_mismatch),
            (2, 'beneficiary_net_exceeds_base', f.net_exceeds_base),
            (3, 'pending_unresolved', f.unresolved),
            (4, 'booked_missing', f.booked_missing)
        ) AS reason (ord, label, hit)
        WHERE reason.hit
      ),
      'booked_n_fen', f.booked_n_fen::text,
      'booked_base_fen', f.booked_base_fen::text,
      'union_receivable_net_fen', f.receivable_net_fen::text,
      'pending_credit_fen', f.pending_fen::text,
      'expected_union_receivable_net_fen', f.expected_receivable_fen::text,
      'beneficiary_net_sum_fen', f.positive_net_sum_fen::text,
      'beneficiary_net_algebraic_sum_fen', f.net_sum_fen::text,
      'beneficiary_keys', f.beneficiary_keys::text,
      'pending_items', f.pending_items
    ) AS detail
  FROM flagged f
  WHERE f.receivable_mismatch
    OR f.net_exceeds_base
    OR f.unresolved
    OR f.booked_missing
),
stats AS (
  SELECT count(*) AS checked_rows FROM candidates
)
SELECT
  '05'::text AS invariant,
  st.checked_rows,
  'global'::text AS scope,
  df.app_id,
  NULL::uuid AS account_id,
  df.detail
FROM differences df
CROSS JOIN stats st
UNION ALL
SELECT
  '05'::text AS invariant,
  st.checked_rows,
  'none'::text AS scope,
  NULL::text AS app_id,
  NULL::uuid AS account_id,
  NULL::jsonb AS detail
FROM stats st
WHERE NOT EXISTS (SELECT 1 FROM differences)
ORDER BY app_id, detail
