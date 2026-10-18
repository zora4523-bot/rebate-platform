# 记账规则（ledger-rules）

本文件是人读版：科目表、uniq_key 总表、借贷模板说明、红冲规则、调账对方科目白名单与口径说明。机读版是同目录 `specs/ledger-templates.csv`（每行一条分录模板）。两者只依据 08 业务规则（规划仓库版本见根目录 `SPEC_REF`）的 BR-FUND-01、04、05、08、09、12、13、15、16、20、22、24，BR-WDR-07、09、20，BR-CALC-02、13，BR-INV-22，以及 02 §8.2 的科目表；代理按 08 起草的取值集中列在「代理起草、待财务确认」节，08 仍没写清的格子写 `TBD(08 未定)`，集中列在「待定」节，不自定。

状态：代理起草，财务确认前按本文件执行（BR-FUND-15、BR-FUND-16 细则「分工」：凭证粒度、科目、红冲规则由代理起草、财务确认）。

## 1. 口径说明

- 金额一律是整数分（bigint，单位分），只用 `packages/money` 运算，不用浮点；比例是万分之一整数（bp）。
- 分录 `amount_fen` 带符号：借为正、贷为负；同一凭证 Σ amount_fen = 0（BR-FUND-16）。csv 的 `sign` 列取 debit / credit，表示借正、贷负。
- 用户负债账户的子户余额 available_fen = −Σ 该子户分录 amount_fen，所以「贷 USER_BALANCE.available」使可用余额增加，「借」使其减少；`balance_after_fen` 是该分录所在子户变动后的余额。
- `ledger_vouchers` 与 `ledger_entries` 只插入（INSERT），应用角色无 UPDATE / DELETE 权限并有防护触发器；更正一律写红冲凭证再重记。
- 每个 uniq_key 对应 1 张凭证 + ≥2 条分录；uniq_key 在 (app_id, uniq_key) 上唯一。uniq_key 冲突视为已入账，跳过且结果与首次相同（BR-FUND-05）。幂等最后落在 PG 唯一约束上。
- 一笔业务可由同一事务内的多张凭证组成；同一子订单的全部凭证、account_balances 更新、orders.booked_base_fen / booked_n_fen 与 rebate_status 迁移在同一 PG 事务内完成。
- 平台科目是热点账户，平台科目不维护实时余额缓存，从分录汇总；只有用户账户有 account_balances 缓存（同事务 `SELECT … FOR UPDATE`，多账户按 account_id 升序，version+1）。
- 会计日按 00:00 +08:00 日切，accounting_date 取写入时注入 `Clock` 的日期（会计日函数只用 packages/domain 提供的）。
- order_key = `{platform}:{sub_order_id}`（如 `taobao:1234567`）；所有订单类 uniq_key 与 advisory lock 都用 order_key，不单用 sub_order_id。
- 账户所有者：用户账户 owner_type=user、owner_id=用户 id、subject=`USER_BALANCE`；平台账户 owner_id 固定为 `platform`，联盟应收的平台维度放在 subject 后缀 `UNION_RECEIVABLE:{platform}`（ledger-plan 裁定 D7）。科目唯一键 (app_id, owner_type, owner_id, subject)。csv 的 `account_owner` 取 user / platform。
- 计入 UNION_RECEIVABLE 的联盟佣金与 booked_n_fen 同口径：都是 BR-CALC-02 的 N（有效联盟佣金的正数部分）；入账基数 B 由 N 按 BR-CALC-02 用快照 reserve_bp 换算（ledger-plan 裁定 D13）。
- 联盟补贴部分是否计入 N、是否进 UNION_RECEIVABLE：待 规划/09 验证，验证前不臆造平台报文。
- 单一余额：每个用户只有一个 USER_BALANCE，含 available、frozen 两个子户；收入来源只由 ledger_type + sub_type 区分（BR-FUND-13）。用户余额不是储值，不提供充值、转账、余额消费。
- ledger_type 只取 contracts/enums/fund.yaml 的 13 个值（BR-FUND-15）；红冲分录沿用被更正分录的 ledger_type 与 sub_type，改派红冲按类型分组逐组反向，不新增类型。平台科目分录沿用所在业务的类型，平台专属凭证取 REBATE_CREDIT 占位（第 7 节）；按 ledger_type 取数的用户口径（流水、收益看板、月末 X1、所得类型）只取用户账户上的分录。
- {role} 占位符取契约 beneficiary_role 的值（self、share、direct、indirect）。

## 2. 科目表

来源 02 §8.2 与 08（BR-FUND-05、08、12、20、24，BR-WDR-09）。

| 科目 subject | 所有者 | 性质 | 说明 |
| --- | --- | --- | --- |
| `USER_BALANCE` | user | 负债 | 用户余额（科目 `USER_BALANCE:{uid}`），子户 available / frozen；只有 ledger 模块改余额 |
| `UNION_RECEIVABLE:{platform}` | platform | 资产 | 应收联盟佣金，按平台分；其分录余额即「已入账未回款」（BR-FUND-20） |
| `CASH_ALIPAY` | platform | 资产 | 企业支付宝余额：提现出金、打款追回、联盟回款 |
| `CASH_WECHAT` | platform | 资产 | 微信零钱通道出金（BR-WDR-09、BR-WDR-33 ⑨） |
| `CASH_BANK` | platform | 资产 | 企业对公银行账户（02 §8.2 候选名，ledger-plan 裁定 D12 定名）；银行卡通道开通前不使用 |
| `COMMISSION_REVENUE` | platform | 收入 | 平台留存佣金（含预留 reserve_fen、FORFEIT 没收份额、注销放弃余额） |
| `FEE_INCOME` | platform | 收入 | 提现手续费（MVP 为 0） |
| `TAX_PAYABLE` | platform | 负债 | 代扣个税 |
| `MKT_EXPENSE` | platform | 费用 | 淘礼金、奖励等营销费用（02 §8.2；RECON_FIX / OTHER 调账白名单科目之一；REWARD P1 前不列模板） |
| `BAD_DEBT` | platform | 费用 | 负余额核销；注销中 / 已注销受益人的扣回与负差改记 |

不设 `WITHDRAW_IN_TRANSIT`：打款中资金留在 USER_BALANCE.frozen（BR-WDR-09、BR-FUND-14）。不设单一的调账科目：调账对方科目按原因码取上表科目（第 6 节）。


## 3. uniq_key 总表

| 业务 | uniq_key 格式 | 依据 |
| --- | --- | --- |
| 受益人入账 | `{order_key}:{user_id}:{role}:CREDIT` | BR-FUND-05 |
| 平台入账 | `{order_key}:PLATFORM:CREDIT` | BR-FUND-05 |
| 被剥夺份额归平台 | `{order_key}:PLATFORM:FORFEIT:{uid}:{role}` | BR-CALC-13（R5 与 R5a 同键） |
| 改派快照下的归平台 | `{order_key}:PLATFORM:FORFEIT:{uid}:{role}:REASSIGN:{reassign_id}` | BR-CALC-13、BR-FUND-01 R14 |
| 延后差额没收 | `{order_key}:PLATFORM:FORFEIT:{uid}:{role}:DEFERRED:{beneficiary_credit_id}` | BR-FUND-04 ⑫、BR-FUND-01 R5a |
| 延后差额补记 | `{order_key}:{user_id}:{role}:ADJ:DEFERRED:{beneficiary_credit_id}` | BR-FUND-04 ⑫ 细则（08 写 `{uid}`，csv 用户行统一写 `{user_id}`） |
| 受益人扣回 | `{order_key}:{user_id}:{role}:CLAWBACK:{rights_event_id}` | BR-FUND-08 |
| 平台扣回差额 | `{order_key}:PLATFORM:CLAWBACK:{rights_event_id}` | BR-FUND-08 |
| 受益人补差 | `{order_key}:{user_id}:{role}:ADJ:{seq}` | BR-FUND-09（正负两路同键） |
| 平台补差差额 | `{order_key}:PLATFORM:ADJ:{seq}` | BR-FUND-09 |
| 受益人恢复 / 申诉补发 | `{order_key}:{user_id}:{role}:RESTORE:{差错单 id}` | BR-FUND-22 |
| 平台恢复 | `{order_key}:PLATFORM:RESTORE:{差错单 id}` | BR-FUND-22 |
| 改派红冲（旧受益人 / 角色） | `{order_key}:{user_id}:{role}:REASSIGN_REV:{reassign_id}` | BR-FUND-01 R14（08 写 `{old_uid}`） |
| 改派红冲（平台） | `{order_key}:PLATFORM:REASSIGN_REV:{reassign_id}` | BR-FUND-01 R14 |
| 改派重记（新受益人） | `{order_key}:{user_id}:{role}:REASSIGN_CREDIT:{reassign_id}` | BR-FUND-01 R14（08 写 `{new_uid}`） |
| 改派重记（平台） | `{order_key}:PLATFORM:REASSIGN_CREDIT:{reassign_id}` | BR-FUND-01 R14 |
| 联盟回款 | `RECEIPT:{platform}:{receipt_id}` | BR-FUND-20 细则「联盟回款凭证」 |
| 提现冻结 / 退回 | `wd:{withdrawal_id}:FREEZE`、`wd:{withdrawal_id}:RETURN` | BR-WDR-09 细则 |
| 提现成功（分录键） | `wd:{withdrawal_id}:PAID`、`wd:{withdrawal_id}:FEE`、`wd:{withdrawal_id}:TAX`；凭证级键待定（第 8 节） | BR-WDR-09 细则 |
| 负余额核销 | `BADDEBT:{account_id}:{candidate_id}` | BR-FUND-12 |
| 人工调账 | `ADJ:{adjust_id}` | BR-FUND-24 ⑥ |
| 调账红冲 | `ADJ:{adjust_id}:REVERSE` | BR-FUND-24 ⑥、BR-FUND-16 |
| 任意更正红冲 | `{原 uniq_key}:REVERSE` | BR-FUND-16 |

rights_event_id 取值（BR-FUND-08）：来自维权 / 处罚接口或导入 → `R{order_rights.id}`；来自订单同步的平台状态变化 → `P{platform_status 迁移后的 row_version}`；来自订单同步的佣金变化 → `C{commission_version}`（同一份联盟数据重放时 commission_version 不变，不生成新键）。占位符拼写照 08 原文（入账、扣回、补差、恢复写 `{user_id}`，FORFEIT 写 `{uid}`）；08 在延后补记、改派红冲 / 重记写的 `{uid}`、`{old_uid}`、`{new_uid}` 在 csv 用户行统一写 `{user_id}`（与用户账户的 owner_id 同一个参数，不另设别名）。

## 4. 借贷模板

下面每节对应 csv 的若干 template_id；csv 每行一条分录，`amount_ref` 是金额来源符号名，不写数值。同一 amount_ref 一借一贷。平台科目分录的 csv sub_account 一律写 `available`（第 7 节）。

### 4.1 入账（BR-FUND-05）

入账基数 B_credit 由 N（orders.settle_commission_fen）按 BR-CALC-02 扣预留换算，按分佣快照拆分；平台留存 = B_credit − Σ受益人份额（Σ 含被剥夺与暂缓的受益人，尾差归平台）。

| template_id | ledger_type / sub_type | 借 | 贷 | 金额 |
| --- | --- | --- | --- | --- |
| `CREDIT:SELF` | REBATE_CREDIT | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | share_fen |
| `CREDIT:SHARE` | SHARE_CREDIT | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | share_fen |
| `CREDIT:DIRECT` | REFERRAL_CREDIT / DIRECT | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | share_fen |
| `CREDIT:INDIRECT` | REFERRAL_CREDIT / INDIRECT（仅 indirect_enabled=true 的版本） | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | share_fen |
| `CREDIT:PLATFORM` | REBATE_CREDIT 占位、sub_type 空（第 7 节） | UNION_RECEIVABLE:{platform} | COMMISSION_REVENUE | platform_credit_fen（= 平台留存 + reserve_fen） |

- 份额为 0 的受益人不写凭证；平台凭证金额 platform_credit_fen（留存 + 预留）大于 0 就写，一借一贷两条，不拆成留存、预留两组；两者都为 0 时不写任何凭证，只迁移状态。
- 被剥夺的受益人不写其凭证，改写 FORFEIT（4.2）；暂缓（held）的受益人不写凭证，解除后按 BR-FUND-04 ⑫ 补记（首次入账义务沿用 `CREDIT:*` 模板，金额为执行时的剩余未履约金额）。
- 同事务 booked_base_fen = B_credit、booked_n_fen = 联盟结算佣金的正数部分、rebate_status→CREDITED；任一凭证借贷不平整个事务回滚、订单保持 WAITING。

### 4.2 归平台（BR-CALC-13）与延后差额（BR-FUND-04 ⑫）

| template_id | ledger_type / sub_type | 借 | 贷 | 金额 |
| --- | --- | --- | --- | --- |
| `FORFEIT` | REBATE_CREDIT 占位、空 | UNION_RECEIVABLE:{platform} | COMMISSION_REVENUE | share_fen（该受益人按入账基数的应得） |
| `FORFEIT:REASSIGN` | REBATE_CREDIT 占位、空 | UNION_RECEIVABLE:{platform} | COMMISSION_REVENUE | share_fen |
| `FORFEIT:DEFERRED` | REBATE_CREDIT 占位、空 | UNION_RECEIVABLE:{platform} | COMMISSION_REVENUE | pending_credit_fen（剩余未履约金额，不是整份应得） |
| `ADJ:DEFERRED:SETTLE_DIFF` | SETTLE_ADJUST / SETTLE_DIFF | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | pending_credit_fen |
| `ADJ:DEFERRED:PRICE_PROTECT` | SETTLE_ADJUST / PRICE_PROTECT | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | pending_credit_fen |
| `ADJ:DEFERRED:PRICE_COMPARE` | SETTLE_ADJUST / PRICE_COMPARE | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | pending_credit_fen |
| `ADJ:DEFERRED:RESTORE` | ADMIN_ADJUST / RESTORE | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | pending_credit_fen |

- 每个被剥夺受益人一张平台凭证，带 forfeit_reason（banned、deleted、minor）；首次入账（R5）与暂缓转没收（R5a）同键；不按原因另设平台科目。
- 暂缓期间 R9 / R10 已把份额并入平台差额的不另写 FORFEIT。
- 延后差额没收只没收当前待补记额 pending_credit_fen，只处置这一笔义务，不追加 forfeited 事件，已入账部分照常参与之后的扣回与补差。
- 延后差额补记按义务上开立时记下的类型（beneficiary_credits.origin_ledger_type、origin_sub_type）四选一：BR-FUND-09 补差开立的取 SETTLE_ADJUST 与开立时那条结算记录的 sub_type，R13 恢复开立的取 ADMIN_ADJUST / RESTORE；之后并入别的来源的延后，整笔仍按开立类型补记。金额为 0 不写。

### 4.3 扣回（BR-FUND-08）

每个 sub_type（FULL、PART_REFUND、RIGHTS、PUNISH）各有一组模板：

| template_id 模式 | ledger_type / sub_type | 借 | 贷 | 金额 |
| --- | --- | --- | --- | --- |
| `CLAWBACK:<sub>:USER` | CLAWBACK / <sub> | USER_BALANCE.available | UNION_RECEIVABLE:{platform} | clawback_fen |
| `CLAWBACK:<sub>:BAD_DEBT` | CLAWBACK / <sub> | BAD_DEBT | UNION_RECEIVABLE:{platform} | clawback_fen |
| `CLAWBACK:<sub>:PLATFORM:DECREASE` | CLAWBACK / <sub>（沿用本次扣回） | COMMISSION_REVENUE | UNION_RECEIVABLE:{platform} | clawback_fen |
| `CLAWBACK:<sub>:PLATFORM:INCREASE` | CLAWBACK / <sub>（沿用本次扣回） | UNION_RECEIVABLE:{platform} | COMMISSION_REVENUE | clawback_fen |

具体 template_id：`CLAWBACK:FULL:USER`、`CLAWBACK:FULL:BAD_DEBT`、`CLAWBACK:FULL:PLATFORM:DECREASE`、`CLAWBACK:FULL:PLATFORM:INCREASE`、`CLAWBACK:PART_REFUND:USER`、`CLAWBACK:PART_REFUND:BAD_DEBT`、`CLAWBACK:PART_REFUND:PLATFORM:DECREASE`、`CLAWBACK:PART_REFUND:PLATFORM:INCREASE`、`CLAWBACK:RIGHTS:USER`、`CLAWBACK:RIGHTS:BAD_DEBT`、`CLAWBACK:RIGHTS:PLATFORM:DECREASE`、`CLAWBACK:RIGHTS:PLATFORM:INCREASE`、`CLAWBACK:PUNISH:USER`、`CLAWBACK:PUNISH:BAD_DEBT`、`CLAWBACK:PUNISH:PLATFORM:DECREASE`、`CLAWBACK:PUNISH:PLATFORM:INCREASE`。

- 受益人扣回额 = 已入账净额 − 按 B_new 与快照重拆的新应得，≤0 不写；只从 available 扣，允许 available 变负，不得扣 frozen。
- 受益人已进入注销 processing 或已注销且净额大于 0：扣回额不写其账户，改借 BAD_DEBT / 贷 UNION_RECEIVABLE（ledger_type、sub_type、uniq_key 不变）。份额从没入过其账户（净额为 0）的不写任何分录。
- 平台差额 = 平台已入账净额 − 按 B_new 的新平台应得（含预留），可正可负，≠0 就写：正数 借 COMMISSION_REVENUE / 贷 UNION_RECEIVABLE（DECREASE），负数 借 UNION_RECEIVABLE / 贷 COMMISSION_REVENUE（INCREASE）。
- 本次全部凭证对 UNION_RECEIVABLE 的净影响 = −(booked_n_fen − N_new 的正数部分) − Σ 待补记额的变化量；同事务 booked_base_fen = B_new、booked_n_fen = N_new 的正数部分。

### 4.4 补差（BR-FUND-09）

每个 sub_type（SETTLE_DIFF 默认；Adapter 能识别原因时 PRICE_PROTECT、PRICE_COMPARE）各有一组：

| template_id 模式 | ledger_type / sub_type | 借 | 贷 | 金额 |
| --- | --- | --- | --- | --- |
| `SETTLE_ADJUST:<sub>:USER:DECREASE`（负差，即时） | SETTLE_ADJUST / <sub> | USER_BALANCE.available | UNION_RECEIVABLE:{platform} | adjust_fen |
| `SETTLE_ADJUST:<sub>:USER:INCREASE`（正差，批准后） | SETTLE_ADJUST / <sub> | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | adjust_fen |
| `SETTLE_ADJUST:<sub>:BAD_DEBT`（注销中 / 已注销的负差） | SETTLE_ADJUST / <sub> | BAD_DEBT | UNION_RECEIVABLE:{platform} | adjust_fen |
| `SETTLE_ADJUST:<sub>:PLATFORM:DECREASE` | SETTLE_ADJUST / <sub>（沿用本次结算记录） | COMMISSION_REVENUE | UNION_RECEIVABLE:{platform} | adjust_fen |
| `SETTLE_ADJUST:<sub>:PLATFORM:INCREASE` | SETTLE_ADJUST / <sub>（沿用本次结算记录） | UNION_RECEIVABLE:{platform} | COMMISSION_REVENUE | adjust_fen |

具体 template_id：`SETTLE_ADJUST:SETTLE_DIFF:USER:DECREASE`、`SETTLE_ADJUST:SETTLE_DIFF:USER:INCREASE`、`SETTLE_ADJUST:SETTLE_DIFF:BAD_DEBT`、`SETTLE_ADJUST:SETTLE_DIFF:PLATFORM:DECREASE`、`SETTLE_ADJUST:SETTLE_DIFF:PLATFORM:INCREASE`、`SETTLE_ADJUST:PRICE_PROTECT:USER:DECREASE`、`SETTLE_ADJUST:PRICE_PROTECT:USER:INCREASE`、`SETTLE_ADJUST:PRICE_PROTECT:BAD_DEBT`、`SETTLE_ADJUST:PRICE_PROTECT:PLATFORM:DECREASE`、`SETTLE_ADJUST:PRICE_PROTECT:PLATFORM:INCREASE`、`SETTLE_ADJUST:PRICE_COMPARE:USER:DECREASE`、`SETTLE_ADJUST:PRICE_COMPARE:USER:INCREASE`、`SETTLE_ADJUST:PRICE_COMPARE:BAD_DEBT`、`SETTLE_ADJUST:PRICE_COMPARE:PLATFORM:DECREASE`、`SETTLE_ADJUST:PRICE_COMPARE:PLATFORM:INCREASE`。

- 分路按整单：负差（B_settle < booked_base_fen，或相等而结算佣金正数部分 < booked_n_fen）在写入 settle_commission_fen 的同一事务内即时写，不等审批；正差进 settle_adjust_batches 候选，step-up 批准后按当前值重算再写（diff=0 或候选 seq ≠ 当前 seq 不写）。diff≠0 才写；负向补差允许 available 变负。
- 两路 uniq_key 相同；同事务 booked_base_fen = B_settle、booked_n_fen = settle_commission_fen 的正数部分。R1 补差不得产生首次入账。
- 受益人负差改记坏账、平台差额的去向与 BR-FUND-08 同口径（「受益人负差改借 BAD_DEBT / 贷 UNION_RECEIVABLE」照录）；用户侧的对方科目 UNION_RECEIVABLE 由「口径同 BR-FUND-08」推得。
- 正差被延后的受益人，其差额按 4.2 的 `ADJ:DEFERRED:*` 补记。

### 4.5 联盟回款（BR-FUND-20）

| template_id | ledger_type / sub_type | 借 | 贷 | 金额 |
| --- | --- | --- | --- | --- |
| `UNION_RECEIPT:CASH_ALIPAY` | REBATE_CREDIT 占位、空 | CASH_ALIPAY | UNION_RECEIVABLE:{platform} | receipt_fen |
| `UNION_RECEIPT:CASH_BANK` | REBATE_CREDIT 占位、空 | CASH_BANK（银行卡通道开通前不使用） | UNION_RECEIVABLE:{platform} | receipt_fen |

由财务在后台录入或经 R1 确认后写凭证；每条回款记录（同一笔回款只登记一条）一张，键 `RECEIPT:{platform}:{receipt_id}`。回款额 receipt_fen 是该笔实际到账额，不是应收额，也不是订单的 N（不能用 n_fen 代替）；与已入账未回款的差额进 R1 差错单，不直接记损益。

### 4.6 提现（BR-WDR-09）

| template_id | ledger_type | 时点 | 借 | 贷 | 金额 |
| --- | --- | --- | --- | --- | --- |
| `WITHDRAW:FREEZE` | WITHDRAW_FREEZE | W1（APPLY，进入 PENDING_REVIEW） | USER_BALANCE.available | USER_BALANCE.frozen | withdraw_fen |
| `WITHDRAW:RETURN` | WITHDRAW_RETURN | W3（驳回，含系统驳回 NEGATIVE_BALANCE）、W6（通道明确失败）、W10 判 FAILED | USER_BALANCE.frozen | USER_BALANCE.available | withdraw_fen |
| `WITHDRAW:SUCCESS:CASH_ALIPAY` | WITHDRAW_PAID + WITHDRAW_FEE + TAX_WITHHOLD | W5、W8、W10 判 PAID_API、W11 | USER_BALANCE.frozen ×3 | CASH_ALIPAY / FEE_INCOME / TAX_PAYABLE | net_fen / fee_fen / tax_fen |
| `WITHDRAW:SUCCESS:CASH_WECHAT` | 同上 | 同上（微信零钱通道，BR-WDR-33 ⑨） | USER_BALANCE.frozen ×3 | CASH_WECHAT / FEE_INCOME / TAX_PAYABLE | 同上 |
| `WITHDRAW:SUCCESS:CASH_BANK` | 同上 | 同上（银行卡通道开通前不使用） | USER_BALANCE.frozen ×3 | CASH_BANK / FEE_INCOME / TAX_PAYABLE | 同上 |

- 打款成功写一张凭证，含三种流水：WITHDRAW_PAID（借 frozen net_fen / 贷现金科目）、WITHDRAW_FEE（借 frozen fee_fen / 贷 FEE_INCOME）、TAX_WITHHOLD（借 frozen tax_fen / 贷 TAX_PAYABLE）。net_fen、fee_fen、tax_fen 取 withdrawals 同名列（BR-WDR-07 ⑤、BR-WDR-09、BR-WDR-20）。
- 提现成功时 净额 net_fen + 手续费 fee_fen + 税 tax_fen = 提现额 amount_fen（三者合计必须等于 amount_fen）。
- 金额为 0 的分录不写（如 MVP 手续费为 0 时不写 WITHDRAW_FEE 两行）。
- W2、W4（EXECUTE）、W7、W9 不写任何分录；冻结金额一直留在 frozen 直到终态，不经过 WITHDRAW_IN_TRANSIT。
- 分录与状态迁移在同一事务内完成；不变量 frozen_fen = Σ 非终态提现单 amount_fen（BR-FUND-14）。
- 三个 `WITHDRAW:SUCCESS:*` 模板的 uniq_key 仍为 `TBD(08 未定)`、不可执行（第 8 节）。

### 4.7 负余额核销（BR-FUND-12）

| template_id | ledger_type | 借 | 贷 | 金额 |
| --- | --- | --- | --- | --- |
| `BAD_DEBT_WRITEOFF` | BAD_DEBT_WRITEOFF | BAD_DEBT | USER_BALANCE.available | writeoff_fen（= −批准时当前 available_fen） |

批准时重读 available 与 frozen：frozen_fen > 0 拒绝批准（开关 ledger.bad_debt_require_no_frozen.enabled 默认 on）；available ≥ 0 时候选单置 CANCELLED，不写凭证。只适用于未注销用户。

### 4.8 恢复（BR-FUND-22，ADMIN_ADJUST / RESTORE）

| template_id | 借 | 贷 | 金额 |
| --- | --- | --- | --- |
| `ADMIN_ADJUST:RESTORE:USER`（R13 受益人差额） | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | restore_fen |
| `ADMIN_ADJUST:RESTORE:PLATFORM`（R13 平台差额，含预留） | UNION_RECEIVABLE:{platform} | COMMISSION_REVENUE | restore_fen |
| `ADMIN_ADJUST:RESTORE:APPEAL`（申诉恢复 ③，封禁期间被没收份额补发） | COMMISSION_REVENUE | USER_BALANCE.available | restore_fen |

RESTORE 只由差错单（「已作废订单被平台恢复」「申诉恢复」）经有权限者 step-up 处理生成；同事务 booked_base_fen = 新基数、booked_n_fen = 该联盟佣金的正数部分。R12（VOID 恢复）不写分录；以「已关闭（不处理）」结案的不写分录。R13 时受益人冻结或申诉中的，差额开立延后差额义务，按 4.2 的 `ADJ:DEFERRED:RESTORE` 补记。

### 4.9 改派（BR-FUND-01 R14：REASSIGN_REV / REASSIGN_CREDIT）

先按旧快照红冲，再按新快照重记，同一事务；两者计入受益人已入账净额（BR-FUND-08）。

**改派重记** `REASSIGN_CREDIT`，按角色 4 个加平台 1 个：

| template_id | ledger_type / sub_type | 借 | 贷 | 金额 |
| --- | --- | --- | --- | --- |
| `REASSIGN_CREDIT:SELF` | REBATE_CREDIT | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | reassign_fen（新快照下的应得） |
| `REASSIGN_CREDIT:SHARE` | SHARE_CREDIT | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | reassign_fen |
| `REASSIGN_CREDIT:DIRECT` | REFERRAL_CREDIT / DIRECT | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | reassign_fen |
| `REASSIGN_CREDIT:INDIRECT` | REFERRAL_CREDIT / INDIRECT | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | reassign_fen |
| `REASSIGN_CREDIT:PLATFORM` | REBATE_CREDIT 占位、空 | UNION_RECEIVABLE:{platform} | COMMISSION_REVENUE | platform_credit_fen（新快照的留存 + 预留） |

新快照下被剥夺的受益人写 `FORFEIT:REASSIGN`；为 0 不写。改派入账义务的补记沿用 `REASSIGN_CREDIT:*` 的键。

**改派红冲** `REASSIGN_REV`，每个旧受益人 / 角色一张（`REASSIGN_REV:USER`）、平台一张（`REASSIGN_REV:PLATFORM`）：

- 按被更正分录的 (ledger_type, sub_type) 分组逐组反向；一张凭证可有多组分录。每组的金额 = 该组分录在该账户上的代数和，按方向取两个金额名之一：`reassign_<type>[_<sub>]_credit_fen`（该组在该账户上合计为贷，红冲借该账户 / 贷 UNION_RECEIVABLE）或 `reassign_<type>[_<sub>]_debit_fen`（合计为借，红冲贷该账户 / 借 UNION_RECEIVABLE）；`<type>`、`<sub>` 为小写的 ledger_type 与 sub_type。
- 金额为 0 的组不写；全部组都为 0 才不写这张凭证；净额为 0 而组不为 0 的照写（如先入账 100、后负向补差 100，红冲仍写入账组、补差组各 100，收益看板才能相抵，BR-FUND-25）。
- `REASSIGN_REV:USER` 的组：REBATE_CREDIT、SHARE_CREDIT、REFERRAL_CREDIT / DIRECT、REFERRAL_CREDIT / INDIRECT、CLAWBACK / FULL、PART_REFUND、RIGHTS、PUNISH、SETTLE_ADJUST / SETTLE_DIFF、PRICE_PROTECT、PRICE_COMPARE、ADMIN_ADJUST / RESTORE；用户各组的对方科目一律是 UNION_RECEIVABLE:{platform}。
- `REASSIGN_REV:PLATFORM` 的组：REBATE_CREDIT（平台入账、三种没收、改派平台重记的占位类型）与上面 8 个扣回 / 补差 / 恢复组；平台各组在 COMMISSION_REVENUE 与 UNION_RECEIVABLE:{platform} 之间反向（申诉补发的借方随平台组冲回）。平台已入账净额含旧快照的 FORFEIT（口径同 BR-FUND-08）。
- 例（BR-FUND-01 细则）：U1 入账 500（REBATE_CREDIT）、部分退款扣回 100（CLAWBACK / PART_REFUND），改派 A2：`…:U1:self:REASSIGN_REV:A2` 写 reassign_rebate_credit_credit_fen=500、reassign_clawback_part_refund_debit_fen=100 两组；平台同样两组。
- 旧受益人已进入注销 processing 或已注销、且在本单键下还有不为 0 的类型组：待负责人决定（第 8 节），csv 不列该情形的模板（没有 `REASSIGN_REV:BAD_DEBT`），这种改派不执行。

### 4.10 活动奖励（REWARD，P1）

REWARD（sub_type newbie / checkin / invite）P1 前不列入 csv：BR-INV-22 规定 MVP 不发放，金额在 P1 规格定；分录模板、键与金额随 P1 规格补（BR-FUND-15 细则末项）。`buildVouchers` 对 `REWARD:*` 一律按未登记模板拒绝。

### 4.11 人工调账（BR-FUND-24，ADMIN_ADJUST）

调增：借 平台科目 / 贷 USER_BALANCE.available；调减反之；uniq_key=`ADJ:{adjust_id}`；金额 admin_adjust_fen（注销为 closing_balance_fen）。调减可使 available < 0，不得写 frozen。

| template_id | sub_type | 对方科目 |
| --- | --- | --- |
| `ADMIN_ADJUST:RECON_FIX:<科目>:INCREASE`、`ADMIN_ADJUST:RECON_FIX:<科目>:DECREASE` | RECON_FIX | 白名单内由发起人选定：`<科目>` ∈ COMMISSION_REVENUE、UNION_RECEIVABLE（科目 UNION_RECEIVABLE:{platform}）、BAD_DEBT、MKT_EXPENSE（第 6 节，待财务确认） |
| `ADMIN_ADJUST:OTHER:<科目>:INCREASE`、`ADMIN_ADJUST:OTHER:<科目>:DECREASE` | OTHER | 同上 |
| `ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_ALIPAY:DECREASE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_ALIPAY:INCREASE` | PAYOUT_RECOVERY | CASH_ALIPAY |
| `ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_WECHAT:DECREASE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_WECHAT:INCREASE` | PAYOUT_RECOVERY | CASH_WECHAT（微信零钱通道） |
| `ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_BANK:DECREASE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_BANK:INCREASE` | PAYOUT_RECOVERY | CASH_BANK（银行卡通道开通前不使用） |
| `ADMIN_ADJUST:ACCOUNT_CLOSED` | ACCOUNT_CLOSED | COMMISSION_REVENUE（只调减） |

RECON_FIX / OTHER 的具体 template_id（按白名单科目拆，同 PAYOUT_RECOVERY 按通道拆的先例）：`ADMIN_ADJUST:OTHER:BAD_DEBT:DECREASE`、`ADMIN_ADJUST:OTHER:BAD_DEBT:INCREASE`、`ADMIN_ADJUST:OTHER:COMMISSION_REVENUE:DECREASE`、`ADMIN_ADJUST:OTHER:COMMISSION_REVENUE:INCREASE`、`ADMIN_ADJUST:OTHER:MKT_EXPENSE:DECREASE`、`ADMIN_ADJUST:OTHER:MKT_EXPENSE:INCREASE`、`ADMIN_ADJUST:OTHER:UNION_RECEIVABLE:DECREASE`、`ADMIN_ADJUST:OTHER:UNION_RECEIVABLE:INCREASE`、`ADMIN_ADJUST:RECON_FIX:BAD_DEBT:DECREASE`、`ADMIN_ADJUST:RECON_FIX:BAD_DEBT:INCREASE`、`ADMIN_ADJUST:RECON_FIX:COMMISSION_REVENUE:DECREASE`、`ADMIN_ADJUST:RECON_FIX:COMMISSION_REVENUE:INCREASE`、`ADMIN_ADJUST:RECON_FIX:MKT_EXPENSE:DECREASE`、`ADMIN_ADJUST:RECON_FIX:MKT_EXPENSE:INCREASE`、`ADMIN_ADJUST:RECON_FIX:UNION_RECEIVABLE:DECREASE`、`ADMIN_ADJUST:RECON_FIX:UNION_RECEIVABLE:INCREASE`。

- 注销（BR-FUND-24 ⑧）：用户进入注销 processing 时 available > 0 的，系统预填 ACCOUNT_CLOSED 调减单，金额按批准时的 available 取（closing_balance_fen），借 USER_BALANCE.available / 贷 COMMISSION_REVENUE，须在注销 done 前完成；余额为负的用户不能申请注销。
- PAYOUT_RECOVERY 的调增模板只是按 ⑥ 的通用方向列出，不表示追回业务有自动调增流程。
- 每个调账模板都有对应红冲模板（第 5 节）：`ADMIN_ADJUST:ACCOUNT_CLOSED:REVERSE`、`ADMIN_ADJUST:OTHER:BAD_DEBT:DECREASE:REVERSE`、`ADMIN_ADJUST:OTHER:BAD_DEBT:INCREASE:REVERSE`、`ADMIN_ADJUST:OTHER:COMMISSION_REVENUE:DECREASE:REVERSE`、`ADMIN_ADJUST:OTHER:COMMISSION_REVENUE:INCREASE:REVERSE`、`ADMIN_ADJUST:OTHER:MKT_EXPENSE:DECREASE:REVERSE`、`ADMIN_ADJUST:OTHER:MKT_EXPENSE:INCREASE:REVERSE`、`ADMIN_ADJUST:OTHER:UNION_RECEIVABLE:DECREASE:REVERSE`、`ADMIN_ADJUST:OTHER:UNION_RECEIVABLE:INCREASE:REVERSE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_ALIPAY:DECREASE:REVERSE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_ALIPAY:INCREASE:REVERSE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_BANK:DECREASE:REVERSE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_BANK:INCREASE:REVERSE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_WECHAT:DECREASE:REVERSE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_WECHAT:INCREASE:REVERSE`、`ADMIN_ADJUST:RECON_FIX:BAD_DEBT:DECREASE:REVERSE`、`ADMIN_ADJUST:RECON_FIX:BAD_DEBT:INCREASE:REVERSE`、`ADMIN_ADJUST:RECON_FIX:COMMISSION_REVENUE:DECREASE:REVERSE`、`ADMIN_ADJUST:RECON_FIX:COMMISSION_REVENUE:INCREASE:REVERSE`、`ADMIN_ADJUST:RECON_FIX:MKT_EXPENSE:DECREASE:REVERSE`、`ADMIN_ADJUST:RECON_FIX:MKT_EXPENSE:INCREASE:REVERSE`、`ADMIN_ADJUST:RECON_FIX:UNION_RECEIVABLE:DECREASE:REVERSE`、`ADMIN_ADJUST:RECON_FIX:UNION_RECEIVABLE:INCREASE:REVERSE`。

## 5. 红冲规则

- 凭证与分录只插入；更正一律写红冲凭证，uniq_key=`{原 uniq_key}:REVERSE`，再按需重记（BR-FUND-16）。红冲分录沿用原分录的 ledger_type、sub_type、科目、子户与金额来源，逐行借贷反向。
- 调账：已执行的调账只能另发调账单写红冲凭证 `ADJ:{adjust_id}:REVERSE` 更正；红冲单关联且只关联 1 张已执行（APPROVED）的原调账单，方向与原单相反，金额由系统按原单 amount_fen 带出。
- 红冲只按原单整笔冲回；不支持部分红冲，要改金额须先整笔红冲再另开新调账单（例：误调 +500 → `ADJ:9001:REVERSE` −500 → 新调账单 +50）。
- 同一张原调账单只能被红冲一次（键唯一）；已被红冲的原单、红冲单本身都不能再被红冲。
- 红冲单仍按调账流程执行（权限点、短信档 step-up、审计）；调减方向的红冲同样允许 available < 0。
- RESTORE 只由差错单生成，不走 `ADJ:` 键；其红冲规则 08 未单列，按通用 `{原 uniq_key}:REVERSE`。


## 6. 调账对方科目白名单（待财务确认）

本节整节待财务确认（ledger-plan 裁定 D14 按方案 A 暂定；调账单任务开工前报负责人）。

| 原因码 | 对方科目 | 依据 |
| --- | --- | --- |
| RESTORE | 按 BR-FUND-22：UNION_RECEIVABLE:{platform}（R13）或 COMMISSION_REVENUE（申诉恢复 ③） | BR-FUND-24 ⑥、BR-FUND-22 |
| PAYOUT_RECOVERY | CASH_ALIPAY；微信零钱通道 CASH_WECHAT；银行卡通道 CASH_BANK（银行卡通道开通前不使用） | BR-FUND-24 ⑥ |
| ACCOUNT_CLOSED | COMMISSION_REVENUE | BR-FUND-24 ⑥⑧ |
| RECON_FIX | 发起人按差错单从白名单选定；方案 A：COMMISSION_REVENUE、UNION_RECEIVABLE:{platform}、BAD_DEBT、MKT_EXPENSE | BR-FUND-24 ⑥（08 只写「由发起人按差错单与 specs/ledger-rules.md 选定」） |
| OTHER | 同 RECON_FIX | 同上 |

csv 中 RECON_FIX、OTHER 按白名单每个科目 × 调增 / 调减 × 正常 / 红冲各列一个模板（共 32 个）；财务改白名单时增删对应模板，不在运行时传入科目参数（参数放不下含冒号的 UNION_RECEIVABLE:{platform}）。

## 7. 代理起草、待财务确认

下列取值由代理按 08（SPEC_REF 版本）与变更记录 `docs/changes/20261018-账务模板待定项.md`（规划仓库）起草；BR-FUND-15、BR-FUND-16 细则「分工」规定凭证粒度、科目、流水类型与红冲规则由代理起草、财务确认，财务确认前按本节执行。任一项被财务或负责人推翻，改本节与 csv 对应格。

| # | 格 | 取值 | 依据 |
| --- | --- | --- | --- |
| 1 | 平台科目分录的 sub_account（csv 全部平台行） | `available`；frozen 只用于用户提现冻结；领域层 buildVouchers 输出的平台分录 sub_account 为 null（decision 29：csv 写库表列值 available，领域分录对非 USER_BALANCE 科目一律 null） | BR-FUND-16 细则「平台科目分录的子户」、BR-FUND-14 |
| 2 | 扣回、补差的平台差额 14 个模板的 ledger_type / sub_type | 沿用所在业务：CLAWBACK / 本次扣回的 sub_type；SETTLE_ADJUST / 本次结算记录的 sub_type；恢复仍为 ADMIN_ADJUST / RESTORE | BR-FUND-15 细则「平台科目分录与几类凭证的 ledger_type」第一项、BR-FUND-08、BR-FUND-09、BR-FUND-22 R13 |
| 3 | 平台专属凭证 `CREDIT:PLATFORM`、`FORFEIT`、`FORFEIT:REASSIGN`、`FORFEIT:DEFERRED`、`REASSIGN_CREDIT:PLATFORM`、`UNION_RECEIPT:CASH_ALIPAY`、`UNION_RECEIPT:CASH_BANK` 的 ledger_type | REBATE_CREDIT 占位、sub_type 空；只为满足 ledger_type 非空，业务类别以凭证业务为准；按 ledger_type 取数的用户口径只取用户账户分录 | BR-FUND-15 细则第一项、BR-FUND-05 细则分录模板表平台一行、BR-FUND-20 细则 |
| 4 | 金额名 `platform_credit_fen` | 平台凭证金额 = 平台留存 + reserve_fen；R14 平台重记同此，按新快照算 | BR-FUND-05 细则「金额名」、BR-CALC-02、BR-CALC-04 |
| 5 | 金额名 `pending_credit_fen` | ⑫ 的剩余未履约金额（执行时取值，即 BR-FUND-19 ⑤ 的待补记额）；用于 `ADJ:DEFERRED:*` 与 `FORFEIT:DEFERRED` | BR-FUND-04 细则「补记与没收的金额名与流水类型」 |
| 6 | 金额名 `receipt_fen` | 该笔联盟实际到账的回款额，不是应收额 | BR-FUND-20 细则「联盟回款凭证」 |
| 7 | 金额名 `net_fen`、`tax_fen` | withdrawals 同名列：net_fen = amount_fen − fee_fen − tax_fen；tax_fen 按 BR-WDR-20 申请时固化 | BR-WDR-07 ⑤、BR-WDR-09、BR-WDR-20 |
| 8 | 延后差额补记 `ADJ:DEFERRED:SETTLE_DIFF`、`ADJ:DEFERRED:PRICE_PROTECT`、`ADJ:DEFERRED:PRICE_COMPARE`、`ADJ:DEFERRED:RESTORE` | 沿用开立该义务的事务的类型：开立时把 (origin_ledger_type, origin_sub_type) 记在义务上，补记时按开立时的类型选模板，不取最新结算记录的原因；合并来源的义务整笔仍按开立类型；键 `{order_key}:{user_id}:{role}:ADJ:DEFERRED:{beneficiary_credit_id}`，借 UNION_RECEIVABLE:{platform} / 贷 USER_BALANCE.available | BR-FUND-04 ⑫ 细则、BR-FUND-15 细则第三项 |
| 9 | 延后差额没收 `FORFEIT:DEFERRED` | 键 `{order_key}:PLATFORM:FORFEIT:{uid}:{role}:DEFERRED:{beneficiary_credit_id}`，借 UNION_RECEIVABLE:{platform} / 贷 COMMISSION_REVENUE，金额 pending_credit_fen，REBATE_CREDIT 占位 | BR-FUND-04 ⑫ 细则、BR-FUND-01 R5a、BR-CALC-13、BR-FUND-15 细则第三项 |
| 10 | 联盟回款键与金额 | 每条回款记录一张，键 `RECEIPT:{platform}:{receipt_id}`，金额 receipt_fen | BR-FUND-20 细则「联盟回款凭证」 |
| 11 | 改派重记 `REASSIGN_CREDIT` 拆 5 个 | 角色 4 个取各自入账类型（BR-FUND-05 分录模板表），平台 1 个取 REBATE_CREDIT 占位、金额 platform_credit_fen | BR-FUND-01 R14、BR-FUND-15 细则第二项 |
| 12 | 改派红冲 `REASSIGN_REV:USER`、`REASSIGN_REV:PLATFORM` | 按被更正分录的 (ledger_type, sub_type) 分组逐组反向，每组金额为该组在该账户上的代数和，按方向分 `_credit_fen` / `_debit_fen` 两个金额名；为 0 的组不写，全部组为 0 才不写凭证；净额为 0 而组不为 0 的照写 | BR-FUND-01 细则「R14 的分录类型」、BR-FUND-15 细则第二项、BR-FUND-25 |
| 13 | RECON_FIX / OTHER 的对方科目 | 按白名单 COMMISSION_REVENUE、UNION_RECEIVABLE:{platform}、BAD_DEBT、MKT_EXPENSE 拆成 32 个模板；白名单本身待财务确认（D14） | BR-FUND-24 ⑥ |
| 14 | REWARD 3 个模板 | 移出 csv，P1 规格定后再补（第 4.10 节占位） | BR-INV-22、BR-FUND-15 细则末项 |
| 15 | 改派时旧受益人注销中 / 已注销且本单键下还有不为 0 的类型组 | 待负责人决定（规划 08 §6.3 第 23 项，选项 A / B / C）；决定前没有分录模板，R14 事务整笔不提交、这种改派不执行；冷静期内的照常红冲 | BR-FUND-01 细则「R14 的分录类型」、BR-FUND-08、BR-ID-28 |

## 8. 待定

以下格子在 csv 中仍为 `TBD(08 未定)`，或 08 本身有待澄清处。TBD 是非执行占位符，不是第十四种枚举，不能写入数据库；含 TBD 的模板 buildVouchers 整张拒绝。

### 8.1 提现成功的 uniq_key

`WITHDRAW:SUCCESS:CASH_ALIPAY`、`WITHDRAW:SUCCESS:CASH_WECHAT`、`WITHDRAW:SUCCESS:CASH_BANK` 的 uniq_key_pattern 为 `TBD(08 未定)`：BR-WDR-09 细则要求打款成功「写一张凭证」，同时给了分录级键 `wd:{withdrawal_id}:PAID`、`wd:{withdrawal_id}:FEE`、`wd:{withdrawal_id}:TAX`，而 BR-FUND-16 要求每个 uniq_key 对应 1 张凭证，三键与一张凭证冲突（08 内部冲突），待规划同步后再定凭证级键。科目、方向、类型与金额名（net_fen / fee_fen / tax_fen）已定。

### 8.2 改派遇旧受益人注销

REASSIGN_REV 遇旧受益人已进入注销 processing 或已注销、且在本单键下还有不为 0 的类型组（用户账户上的，或改记坏账的扣回）：这部分记在哪里待负责人决定（第 7 节第 15 项）；csv 没有该情形的模板，决定前这种改派不执行。

### 8.3 08 内部其他待澄清

- BR-FUND-08「份额从没入过其账户……不写任何分录，没收的份额随平台已入账净额冲回（平台坏账）」：平台这部分是否借 BAD_DEBT 而非 COMMISSION_REVENUE，原文未写清；csv 只按平台差额通用模板（COMMISSION_REVENUE ↔ UNION_RECEIVABLE）列出。
- BR-FUND-22 R13 的差额只给了一个方向（借 UNION_RECEIVABLE / 贷 用户或 COMMISSION_REVENUE）；新应得低于当前净额时的负差是否出现、如何记，原文未写。
- 联盟补贴是否计入 N 与 UNION_RECEIVABLE：待 规划/09 验证（D13）。
- 京东实际佣金由 >0 变 0 的口径待 规划/09 验证，验证前按全额扣回处理并生成差错单（BR-FUND-08）。

## 9. 与 csv 的对应

csv 列：`template_id,ledger_type,sub_type,uniq_key_pattern,line,account_owner,subject,sub_account,sign,amount_ref,note`；按 template_id 升序，同模板 line 从 1 起。template_id 只是表内名字，不是流水枚举；业务比对单位是 (ledger_type, sub_type, uniq_key_pattern) 一组。note 列为自由说明。csv 由 `node packages/domain/src/ledger/generate-templates.ts` 生成 `packages/domain/src/ledger/templates.gen.ts`，buildVouchers 只读生成物。
