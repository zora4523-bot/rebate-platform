# 记账规则（ledger-rules）

本文件是人读版：科目表、uniq_key 总表、借贷模板说明、红冲规则、调账对方科目白名单与口径说明。机读版是同目录 `specs/ledger-templates.csv`（每行一条分录模板）。两者只依据 08 业务规则（规划仓库版本见根目录 `SPEC_REF`）的 BR-FUND-05、08、09、12、13、15、16、20、22、24，BR-WDR-09，BR-CALC-13，以及 02 §8.2 的科目表；08 没写清的格子一律写 `TBD(08 未定)`，集中列在文末「待定」节，不自定。

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
- ledger_type 只取 contracts/enums/fund.yaml 的 13 个值（BR-FUND-15）；红冲与改派重记的分录沿用被更正分录的 ledger_type 与 sub_type，不新增类型。
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
| `MKT_EXPENSE` | platform | 费用 | 淘礼金、奖励等营销费用（02 §8.2；本表暂无已定模板使用，REWARD 模板待定） |
| `BAD_DEBT` | platform | 费用 | 负余额核销；注销中 / 已注销受益人的扣回与负差改记 |

不设 `WITHDRAW_IN_TRANSIT`：打款中资金留在 USER_BALANCE.frozen（BR-WDR-09、BR-FUND-14）。不设单一的调账科目：调账对方科目按原因码取上表科目（第 6 节）。

## 3. uniq_key 总表

| 业务 | uniq_key 格式 | 依据 |
| --- | --- | --- |
| 受益人入账 | `{order_key}:{user_id}:{role}:CREDIT` | BR-FUND-05 |
| 平台入账 | `{order_key}:PLATFORM:CREDIT` | BR-FUND-05 |
| 被剥夺份额归平台 | `{order_key}:PLATFORM:FORFEIT:{uid}:{role}` | BR-CALC-13（R5 与 R5a 同键） |
| 改派快照下的归平台 | `{order_key}:PLATFORM:FORFEIT:{uid}:{role}:REASSIGN:{reassign_id}` | BR-CALC-13、BR-FUND-01 R14 |
| 受益人扣回 | `{order_key}:{user_id}:{role}:CLAWBACK:{rights_event_id}` | BR-FUND-08 |
| 平台扣回差额 | `{order_key}:PLATFORM:CLAWBACK:{rights_event_id}` | BR-FUND-08 |
| 受益人补差 | `{order_key}:{user_id}:{role}:ADJ:{seq}` | BR-FUND-09（正负两路同键） |
| 平台补差差额 | `{order_key}:PLATFORM:ADJ:{seq}` | BR-FUND-09 |
| 受益人恢复 / 申诉补发 | `{order_key}:{user_id}:{role}:RESTORE:{差错单 id}` | BR-FUND-22 |
| 平台恢复 | `{order_key}:PLATFORM:RESTORE:{差错单 id}` | BR-FUND-22 |
| 提现冻结 / 退回 | `wd:{withdrawal_id}:FREEZE`、`wd:{withdrawal_id}:RETURN` | BR-WDR-09 细则 |
| 提现成功（分录键） | `wd:{withdrawal_id}:PAID`、`wd:{withdrawal_id}:FEE`、`wd:{withdrawal_id}:TAX` | BR-WDR-09 细则 |
| 负余额核销 | `BADDEBT:{account_id}:{candidate_id}` | BR-FUND-12 |
| 人工调账 | `ADJ:{adjust_id}` | BR-FUND-24 ⑥ |
| 调账红冲 | `ADJ:{adjust_id}:REVERSE` | BR-FUND-24 ⑥、BR-FUND-16 |
| 任意更正红冲 | `{原 uniq_key}:REVERSE` | BR-FUND-16 |
| 联盟回款、改派红冲 / 重记、延后差额没收、REWARD | `TBD(08 未定)` | 见「待定」 |

rights_event_id 取值（BR-FUND-08）：来自维权 / 处罚接口或导入 → `R{order_rights.id}`；来自订单同步的平台状态变化 → `P{platform_status 迁移后的 row_version}`；来自订单同步的佣金变化 → `C{commission_version}`（同一份联盟数据重放时 commission_version 不变，不生成新键）。占位符拼写照 08 原文（入账、扣回、补差、恢复写 `{user_id}`，FORFEIT 写 `{uid}`）。

## 4. 借贷模板

下面每节对应 csv 的若干 template_id；csv 每行一条分录，`amount_ref` 是金额来源符号名，不写数值。同一 amount_ref 一借一贷。

### 4.1 入账（BR-FUND-05）

入账基数 B_credit 由 N（orders.settle_commission_fen）按 BR-CALC-02 扣预留换算，按分佣快照拆分；平台留存 = B_credit − Σ受益人份额（Σ 含被剥夺与暂缓的受益人，尾差归平台）。

| template_id | ledger_type / sub_type | 借 | 贷 | 金额 |
| --- | --- | --- | --- | --- |
| `CREDIT:SELF` | REBATE_CREDIT | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | share_fen |
| `CREDIT:SHARE` | SHARE_CREDIT | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | share_fen |
| `CREDIT:DIRECT` | REFERRAL_CREDIT / DIRECT | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | share_fen |
| `CREDIT:INDIRECT` | REFERRAL_CREDIT / INDIRECT（仅 indirect_enabled=true 的版本） | UNION_RECEIVABLE:{platform} | USER_BALANCE.available | share_fen |
| `CREDIT:PLATFORM` | TBD(08 未定) | UNION_RECEIVABLE:{platform} | COMMISSION_REVENUE | 平台留存 + reserve_fen 的合计（TBD） |

- 份额为 0 的受益人不写凭证；平台凭证金额（留存 + 预留）大于 0 就写，一借一贷两条，不拆成留存、预留两组；两者都为 0 时不写任何凭证，只迁移状态。
- 被剥夺的受益人不写其凭证，改写 FORFEIT（4.2）；暂缓（held）的受益人不写凭证，解除后按 BR-FUND-04 ⑫ 补记。
- 同事务 booked_base_fen = B_credit、booked_n_fen = 联盟结算佣金的正数部分、rebate_status→CREDITED；任一凭证借贷不平整个事务回滚、订单保持 WAITING。

### 4.2 归平台（BR-CALC-13）

| template_id | 借 | 贷 | 金额 |
| --- | --- | --- | --- |
| `FORFEIT` | UNION_RECEIVABLE:{platform} | COMMISSION_REVENUE | share_fen（该受益人按入账基数的应得） |
| `FORFEIT:REASSIGN` | UNION_RECEIVABLE:{platform} | COMMISSION_REVENUE | share_fen |
| `FORFEIT:DEFERRED` | TBD(08 未定) | TBD(08 未定) | TBD(08 未定) |

- 每个被剥夺受益人一张平台凭证，带 forfeit_reason（banned、deleted、minor）；首次入账（R5）与暂缓转没收（R5a）同键；不按原因另设平台科目。
- 暂缓期间 R9 / R10 已把份额并入平台差额的不另写 FORFEIT。
- 延后差额没收（BR-FUND-04 ⑫ 的延后差额义务）只没收当前待补记额，不追加 forfeited 事件；其键与金额在 BR-FUND-04 ⑫，本任务未摘录，故 `FORFEIT:DEFERRED` 只留占位。

### 4.3 扣回（BR-FUND-08）

每个 sub_type（FULL、PART_REFUND、RIGHTS、PUNISH）各有一组模板：

| template_id 模式 | ledger_type / sub_type | 借 | 贷 | 金额 |
| --- | --- | --- | --- | --- |
| `CLAWBACK:<sub>:USER` | CLAWBACK / <sub> | USER_BALANCE.available | UNION_RECEIVABLE:{platform} | clawback_fen |
| `CLAWBACK:<sub>:BAD_DEBT` | CLAWBACK / <sub> | BAD_DEBT | UNION_RECEIVABLE:{platform} | clawback_fen |
| `CLAWBACK:<sub>:PLATFORM:DECREASE` | TBD(08 未定) | COMMISSION_REVENUE | UNION_RECEIVABLE:{platform} | clawback_fen |
| `CLAWBACK:<sub>:PLATFORM:INCREASE` | TBD(08 未定) | UNION_RECEIVABLE:{platform} | COMMISSION_REVENUE | clawback_fen |

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
| `SETTLE_ADJUST:<sub>:PLATFORM:DECREASE` | TBD(08 未定) | COMMISSION_REVENUE | UNION_RECEIVABLE:{platform} | adjust_fen |
| `SETTLE_ADJUST:<sub>:PLATFORM:INCREASE` | TBD(08 未定) | UNION_RECEIVABLE:{platform} | COMMISSION_REVENUE | adjust_fen |

具体 template_id：`SETTLE_ADJUST:SETTLE_DIFF:USER:DECREASE`、`SETTLE_ADJUST:SETTLE_DIFF:USER:INCREASE`、`SETTLE_ADJUST:SETTLE_DIFF:BAD_DEBT`、`SETTLE_ADJUST:SETTLE_DIFF:PLATFORM:DECREASE`、`SETTLE_ADJUST:SETTLE_DIFF:PLATFORM:INCREASE`、`SETTLE_ADJUST:PRICE_PROTECT:USER:DECREASE`、`SETTLE_ADJUST:PRICE_PROTECT:USER:INCREASE`、`SETTLE_ADJUST:PRICE_PROTECT:BAD_DEBT`、`SETTLE_ADJUST:PRICE_PROTECT:PLATFORM:DECREASE`、`SETTLE_ADJUST:PRICE_PROTECT:PLATFORM:INCREASE`、`SETTLE_ADJUST:PRICE_COMPARE:USER:DECREASE`、`SETTLE_ADJUST:PRICE_COMPARE:USER:INCREASE`、`SETTLE_ADJUST:PRICE_COMPARE:BAD_DEBT`、`SETTLE_ADJUST:PRICE_COMPARE:PLATFORM:DECREASE`、`SETTLE_ADJUST:PRICE_COMPARE:PLATFORM:INCREASE`。

- 分路按整单：负差（B_settle < booked_base_fen，或相等而结算佣金正数部分 < booked_n_fen）在写入 settle_commission_fen 的同一事务内即时写，不等审批；正差进 settle_adjust_batches 候选，step-up 批准后按当前值重算再写（diff=0 或候选 seq ≠ 当前 seq 不写）。diff≠0 才写；负向补差允许 available 变负。
- 两路 uniq_key 相同；同事务 booked_base_fen = B_settle、booked_n_fen = settle_commission_fen 的正数部分。R1 补差不得产生首次入账。
- 受益人负差改记坏账、平台差额的去向与 BR-FUND-08 同口径（「受益人负差改借 BAD_DEBT / 贷 UNION_RECEIVABLE」照录）；用户侧的对方科目 UNION_RECEIVABLE 由「口径同 BR-FUND-08」推得。

### 4.5 联盟回款（BR-FUND-20）

| template_id | 借 | 贷 | 金额 |
| --- | --- | --- | --- |
| `UNION_RECEIPT:CASH_ALIPAY` | CASH_ALIPAY | UNION_RECEIVABLE:{platform} | 回款额（TBD） |
| `UNION_RECEIPT:CASH_BANK` | CASH_BANK（银行卡通道开通前不使用） | UNION_RECEIVABLE:{platform} | 回款额（TBD） |

由财务在后台录入或经 R1 确认后写凭证。回款额不是订单的 N，不能用 n_fen 代替。uniq_key、ledger_type 见「待定」。

### 4.6 提现（BR-WDR-09）

| template_id | ledger_type | 时点 | 借 | 贷 | 金额 |
| --- | --- | --- | --- | --- | --- |
| `WITHDRAW:FREEZE` | WITHDRAW_FREEZE | W1（APPLY，进入 PENDING_REVIEW） | USER_BALANCE.available | USER_BALANCE.frozen | withdraw_fen |
| `WITHDRAW:RETURN` | WITHDRAW_RETURN | W3（驳回，含系统驳回 NEGATIVE_BALANCE）、W6（通道明确失败）、W10 判 FAILED | USER_BALANCE.frozen | USER_BALANCE.available | withdraw_fen |
| `WITHDRAW:SUCCESS:CASH_ALIPAY` | WITHDRAW_PAID + WITHDRAW_FEE + TAX_WITHHOLD | W5、W8、W10 判 PAID_API、W11 | USER_BALANCE.frozen ×3 | CASH_ALIPAY / FEE_INCOME / TAX_PAYABLE | net_fen / fee_fen / tax_fen |
| `WITHDRAW:SUCCESS:CASH_WECHAT` | 同上 | 同上（微信零钱通道，BR-WDR-33 ⑨） | USER_BALANCE.frozen ×3 | CASH_WECHAT / FEE_INCOME / TAX_PAYABLE | 同上 |
| `WITHDRAW:SUCCESS:CASH_BANK` | 同上 | 同上（银行卡通道开通前不使用） | USER_BALANCE.frozen ×3 | CASH_BANK / FEE_INCOME / TAX_PAYABLE | 同上 |

- 打款成功写一张凭证，含三种流水：WITHDRAW_PAID（借 frozen net_fen / 贷现金科目）、WITHDRAW_FEE（借 frozen fee_fen / 贷 FEE_INCOME）、TAX_WITHHOLD（借 frozen tax_fen / 贷 TAX_PAYABLE）。
- 提现成功时 净额 net_fen + 手续费 fee_fen + 税 tax_fen = 提现额 amount_fen（三者合计必须等于 amount_fen）。
- 金额为 0 的分录不写（如 MVP 手续费为 0 时不写 WITHDRAW_FEE 两行）。
- W2、W4（EXECUTE）、W7、W9 不写任何分录；冻结金额一直留在 frozen 直到终态，不经过 WITHDRAW_IN_TRANSIT。
- 分录与状态迁移在同一事务内完成；不变量 frozen_fen = Σ 非终态提现单 amount_fen（BR-FUND-14）。

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

RESTORE 只由差错单（「已作废订单被平台恢复」「申诉恢复」）经有权限者 step-up 处理生成；同事务 booked_base_fen = 新基数、booked_n_fen = 该联盟佣金的正数部分。R12（VOID 恢复）不写分录；以「已关闭（不处理）」结案的不写分录。

### 4.9 改派（REASSIGN_REV / REASSIGN_CREDIT）

| template_id | 说明 |
| --- | --- |
| `REASSIGN_REV` | 改派红冲：沿用被更正分录的 ledger_type 与 sub_type（BR-FUND-15）；键、科目见 BR-FUND-01 R14，本任务未摘录，除金额来源 reassign_fen 外全部 TBD |
| `REASSIGN_CREDIT` | 改派重记：同上 |

两者计入受益人已入账净额（BR-FUND-08）。

### 4.10 活动奖励（REWARD，P1）

`REWARD:newbie`、`REWARD:checkin`、`REWARD:invite`：08 只给了 sub_type 值域（BR-FUND-15），模板 TBD。

### 4.11 人工调账（BR-FUND-24，ADMIN_ADJUST）

调增：借 平台科目 / 贷 USER_BALANCE.available；调减反之；uniq_key=`ADJ:{adjust_id}`；金额 admin_adjust_fen（注销为 closing_balance_fen）。调减可使 available < 0，不得写 frozen。

| template_id | sub_type | 对方科目 |
| --- | --- | --- |
| `ADMIN_ADJUST:RECON_FIX:INCREASE`、`ADMIN_ADJUST:RECON_FIX:DECREASE` | RECON_FIX | 白名单内由发起人选定（TBD，第 6 节） |
| `ADMIN_ADJUST:OTHER:INCREASE`、`ADMIN_ADJUST:OTHER:DECREASE` | OTHER | 白名单内由发起人选定（TBD，第 6 节） |
| `ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_ALIPAY:DECREASE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_ALIPAY:INCREASE` | PAYOUT_RECOVERY | CASH_ALIPAY |
| `ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_WECHAT:DECREASE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_WECHAT:INCREASE` | PAYOUT_RECOVERY | CASH_WECHAT（微信零钱通道） |
| `ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_BANK:DECREASE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_BANK:INCREASE` | PAYOUT_RECOVERY | CASH_BANK（银行卡通道开通前不使用） |
| `ADMIN_ADJUST:ACCOUNT_CLOSED` | ACCOUNT_CLOSED | COMMISSION_REVENUE（只调减） |

- 注销（BR-FUND-24 ⑧）：用户进入注销 processing 时 available > 0 的，系统预填 ACCOUNT_CLOSED 调减单，金额按批准时的 available 取（closing_balance_fen），借 USER_BALANCE.available / 贷 COMMISSION_REVENUE，须在注销 done 前完成；余额为负的用户不能申请注销。
- PAYOUT_RECOVERY 的调增模板只是按 ⑥ 的通用方向列出，不表示追回业务有自动调增流程。
- 每个调账模板都有对应红冲模板（第 5 节）：`ADMIN_ADJUST:RECON_FIX:INCREASE:REVERSE`、`ADMIN_ADJUST:RECON_FIX:DECREASE:REVERSE`、`ADMIN_ADJUST:OTHER:INCREASE:REVERSE`、`ADMIN_ADJUST:OTHER:DECREASE:REVERSE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_ALIPAY:DECREASE:REVERSE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_ALIPAY:INCREASE:REVERSE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_WECHAT:DECREASE:REVERSE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_WECHAT:INCREASE:REVERSE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_BANK:DECREASE:REVERSE`、`ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_BANK:INCREASE:REVERSE`、`ADMIN_ADJUST:ACCOUNT_CLOSED:REVERSE`。

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
| RECON_FIX | 发起人按差错单从白名单选定；方案 A 候选：COMMISSION_REVENUE、UNION_RECEIVABLE:{platform}、BAD_DEBT、MKT_EXPENSE | BR-FUND-24 ⑥（08 只写「由发起人按差错单与 specs/ledger-rules.md 选定」） |
| OTHER | 同 RECON_FIX | 同上 |

csv 中 RECON_FIX、OTHER 的对方科目格保持 `TBD(08 未定)`：候选名单不是 08 原文，财务确认前不写进机读模板。

## 7. 待定

以下格子在 csv 中为 `TBD(08 未定)`，或 08 本身有待澄清处。TBD 是非执行占位符，不是第十四种枚举，不能写入数据库。

### 7.1 平台凭证的 ledger_type 与 sub_type

平台专属凭证（`CREDIT:PLATFORM`、`FORFEIT`、`FORFEIT:REASSIGN`、各 `CLAWBACK:*:PLATFORM:*`、各 `SETTLE_ADJUST:*:PLATFORM:*`、`UNION_RECEIPT:*`）的 ledger_type 与 sub_type 08 未给；BR-FUND-15 又要求 ledger_entries.ledger_type 只取 13 个值，平台分录用哪一个须财务定（ledger_type 为 TBD 时 sub_type 也为 TBD）。平台 RESTORE 08 明确为 ADMIN_ADJUST / RESTORE，照录。

### 7.2 平台科目的 sub_account

平台科目分录的 sub_account 08 未明确取 available 还是 frozen（只有用户账户有两个子户的定义）；csv 全部写 TBD。

### 7.3 词表外的金额

- `CREDIT:PLATFORM` 金额 = 平台留存 + reserve_fen 的合计，不在 amount_ref 词表，写 TBD（凭证结构照原文一借一贷）。
- 提现成功的 net_fen（实际到账）与 tax_fen（代扣个税）不在词表，写 TBD；不能用 withdraw_fen 或 fee_fen 代替。
- 联盟回款额不在词表，写 TBD；不能用 n_fen 代替。

### 7.4 联盟回款

联盟回款的 uniq_key、ledger_type、sub_type 与金额来源 08 未给（BR-FUND-20 只给了借 CASH_ALIPAY 或银行科目 / 贷 UNION_RECEIVABLE:{platform}）。

### 7.5 改派 REASSIGN

REASSIGN_REV / REASSIGN_CREDIT 只有「沿用被更正分录的 ledger_type 与 sub_type」与「计入已入账净额」的约束；完整键与账户模板在 BR-FUND-01 R14，本任务未摘录，全部 TBD。

### 7.6 活动奖励 REWARD

REWARD（P1）只有 sub_type 值域 newbie / checkin / invite，没有分录模板与键；02 §8.2 的 MKT_EXPENSE 可能是对方科目，但 08 未写，不推断。

### 7.7 延后差额没收

`FORFEIT:DEFERRED`：BR-CALC-13 只说明没收当前待补记额、只处置这一笔义务、不追加 forfeited 事件，键与金额转引 BR-FUND-04 ⑫（未摘录），科目、类型、键、金额全部 TBD；所有者暂按「没收归平台」记 platform。

### 7.8 调账白名单

RECON_FIX、OTHER 的对方科目白名单 08 未给，方案 A 候选见第 6 节，待财务确认；csv 对应格为 TBD。

### 7.9 08 内部待澄清

- 提现成功「写一张凭证」与 BR-FUND-16「每个 uniq_key 对应 1 张凭证」：BR-WDR-09 细则又给了分录级键 `wd:{withdrawal_id}:PAID/FEE/TAX`。csv 按分录键照录，凭证级键如何落地待定。
- BR-FUND-08「份额从没入过其账户……不写任何分录，没收的份额随平台已入账净额冲回（平台坏账）」：平台这部分是否借 BAD_DEBT 而非 COMMISSION_REVENUE，原文未写清；csv 只按平台差额通用模板（COMMISSION_REVENUE ↔ UNION_RECEIVABLE）列出。
- BR-FUND-22 R13 的差额只给了一个方向（借 UNION_RECEIVABLE / 贷 用户或 COMMISSION_REVENUE）；新应得低于当前净额时的负差是否出现、如何记，原文未写。
- 联盟补贴是否计入 N 与 UNION_RECEIVABLE：待 规划/09 验证（D13）。
- 京东实际佣金由 >0 变 0 的口径待 规划/09 验证，验证前按全额扣回处理并生成差错单（BR-FUND-08）。

## 8. 与 csv 的对应

csv 列：`template_id,ledger_type,sub_type,uniq_key_pattern,line,account_owner,subject,sub_account,sign,amount_ref,note`；按 template_id 升序，同模板 line 从 1 起。template_id 只是表内名字，不是流水枚举；业务比对单位是 (ledger_type, sub_type, uniq_key_pattern) 一组。note 列为自由说明。
