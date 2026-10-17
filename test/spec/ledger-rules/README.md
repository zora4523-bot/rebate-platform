# B2-01i 独立规则预期

本目录属于 test 阶段。`expected.csv` 只依据任务书 §2/2b、funds-quote 补充及固定版本 `038229e4a646dbd0b9ac5c8784dc0c931c739b51` 的 02 §8.2 科目表编写，没有读取实现表。实现方交付 `specs/ledger-templates.csv` 和 `specs/ledger-rules.md`；本轮不生成这两个文件，文档也不放 TypeScript 函数骨架。

测试全部是顶层 `it`。每个测试在读取待交付文件之前先断言文件存在，缺文件会形成断言失败，不会在收集测试时抛 ENOENT。测试只读仓库内文本，不运行应用、不连接数据库、不监听端口。先红由编排者在隔离容器核对，宿主只做类型检查和 lint。

## 表格编码约定

- 固定十一列，按 `template_id` 的 ASCII 顺序排列；同模板行号从 1 连续，`template_id + line` 唯一。这两列只检查表内结构，不参与两表比对。按任务书第 10 节，以 `(ledger_type, sub_type, uniq_key_pattern)` 分组，两表的组集合须完全相等；每组按 `(account_owner, subject, sub_account, sign, amount_ref)` 比较无序多重集合，重复行的数量也须相等。note 不参与比对，可以自由改写，支持 CSV 引号、转义双引号及换行。
- 标识名不是新的流水枚举，也不要求实现表采用 expected 的名字。本预期表用 `CREDIT:SELF/SHARE/DIRECT/INDIRECT/PLATFORM` 区分入账，`USER/BAD_DEBT/PLATFORM` 区分科目去向，`INCREASE/DECREASE` 表示余额或平台收入方向，渠道用科目名后缀。文档须索引实现表自己的全部 template_id；同一成功凭证内允许三种流水类型。业务三元组可能合并正负方向、不同通道或多个待定模板，组是比较单位，不是可直接执行的一张凭证。
- 参数名忠实保留摘录：入账、扣回、补差与恢复用 `{user_id}`；FORFEIT 用 `{uid}`；恢复用 `{差错单 id}`。这些是文本占位符，实际运行时不是拼接字面量。`order_key` 必须已经包含平台。
- `CREDIT:PLATFORM` 按 BR-FUND-05 只写一借一贷两行：借 UNION_RECEIVABLE / 贷 COMMISSION_REVENUE，金额为平台留存加预留的合计。该合计不在 amount_ref 词表，故两行金额来源均为 `TBD(08 未定)`；这是编码词表缺项，不是金额计算规则未定，不拆成四行，也不擅自扩充词表。
- `WITHDRAW:SUCCESS:<现金科目>` 的六行表示一张成功凭证。`wd:...:PAID/FEE/TAX` 按 BR-WDR-09 细则保留分录业务键，不能据此拆成三张凭证；凭证级键与分录级键的具体落地需在规格待定节澄清。成功净额、手续费与税额之和等于提现额，零金额行省略。
- 红冲按 uniq_key_pattern 的 `:REVERSE` 后缀定位同类型、同子类型的原业务组，不依赖模板名或行号；保留科目、子户、金额来源，对原组逐行反号后比较无序多重集合。ACCOUNT_CLOSED、RECON_FIX 和 OTHER 的正负调账、PAYOUT_RECOVERY 的各通道与方向均有对应红冲（ACCOUNT_CLOSED 只有规则给出的注销调减及其红冲）；未明确的对方科目仍为 TBD。PAYOUT_RECOVERY 的调增模板沿用 BR-FUND-24 ⑥ 通用调账方向，不表示追回业务新增了自动调增流程。通用整笔红冲规则仍须在 md 说明，包括仅一次、禁止红冲红冲单、改金额须红冲后另开新单。
- 每种金额来源的借贷次数必须相等，这是模板符号平衡检查，不是业务金额计算测试。待定金额借贷成对只说明结构占位，不能视为可执行凭证。

## 有意保留的待定字段

`TBD(08 未定)` 是非执行占位符。业务组内各分录的字段值（含 TBD）与重复次数须与独立预期表一致，不按行号定位；不得把其他已定字段改成 TBD，也不得猜值替换待定字段。所有已定流水类型仍须属于 `contracts/enums/fund.yaml` 的十三值集合；TBD 本身不是第十四种枚举，也不能写入数据库。ledger_type 为 TBD 时 sub_type 也必须为 TBD；确定没有 sub_type 的 CSV 空格表示无子类型，不能直接作为数据库空字符串写入。

- 平台专属 CREDIT、FORFEIT、CLAWBACK 平台差额、SETTLE_ADJUST 平台差额和联盟回款的流水类型及子类型，摘录没有给出，统一为 TBD；没有按受益人流水推断平台流水类型。BR-FUND-22 明确给出平台 RESTORE 的 ADMIN_ADJUST/RESTORE，BR-FUND-08/09 明确要求受益人负差改记坏账时类型不变，这些照录。平台科目 `sub_account` 也未明确取 available 还是 frozen，因此待定；数据库只接受这两种值不等于业务规则已选定其中一种。平台 owner_id 固定为 `platform`，联盟应收平台维度放在 subject 后缀（D7）。
- 成功提现的 `net_fen`、`tax_fen` 不在任务规定的 amount_ref 词表，因此保留已知科目、方向及类型，金额来源标 TBD，不能拿 `withdraw_fen` 或 `fee_fen` 替代。回款金额不是订单联盟佣金 N，不能因词表有 `n_fen` 就用它替代实际回款金额。
- 联盟回款的幂等键、流水类型、金额符号未给出；支付宝及银行科目方向由 BR-FUND-20 给出。现金银行科目按 D12 命名 CASH_BANK，并要求 md 标注“银行卡通道开通前不使用”。
- RECON_FIX、OTHER 的对方科目白名单 A 未随摘录给出具体集合，保留为平台科目 TBD；md 必须整节标“待财务确认”。RESTORE、PAYOUT_RECOVERY、ACCOUNT_CLOSED 的已给定对方科目照录。
- REASSIGN_REV / REASSIGN_CREDIT 只有沿用原类型与子类型的约束，摘录未给出完整键和账户模板，故作为待定模板保留。已明确的改派 FORFEIT 单独完整保留。REWARD 的三个 sub_type 有枚举，没有完整模板，未知格也保留 TBD。
- 延后差额没收按本轮补充保留 `FORFEIT:DEFERRED` 占位借贷行：BR-CALC-13 只说明没收当前待补记额、只处置该义务、不追加 forfeited 事件；凭证键与金额转引未摘录的 BR-FUND-04 ⑫，因此科目、类型、键和金额来源均不推断，待后续补齐原文。占位行不代表已决定可执行模板。
- D13 的 UNION_RECEIVABLE 与 booked_n_fen 都采用 BR-CALC-02 的 N 口径；补贴须在 md 标为待规划/09验证。此处不读取或补造真实平台报文。

## 验收边界

十条规则测试覆盖 CSV 结构与业务组分录多重集合一致、契约枚举、符号平衡、科目与子户、红冲，以及 md 的模板/科目/键索引、待定说明和口径要点。待定节可以含子标题，读取范围到下一个同级或更高级标题；文档还须写明提现成功时净额 + 手续费 + 税 = 提现额、uniq_key 冲突视为已入账并跳过、平台科目不维护实时余额缓存。文档测试只检查必要说明是否存在，不能代替资金评审对正文含义的判断。事务、并发锁、实时余额更新、真实舍入计算和运行时幂等属于后续实现任务；本任务不假装用读文档测试证明数据库行为。

需要编排者执行：`tools/ops/verify-container.sh B2-01i --red`。预计当前十条测试全部因缺少待交付规格的存在性断言而红；该结果尚未经本会话运行验证。
