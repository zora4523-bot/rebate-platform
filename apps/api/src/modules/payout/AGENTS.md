# apps/api/src/modules/payout（资金：提现与打款）

提现单的申请校验、建单与冻结、状态机、提现冻结记录（withdraw_holds）、自动到账判定、批次与打款通道（PayoutChannel）、结果查询与人工处置、通道对账与垫资水位。只有本模块写 withdrawals、withdraw_holds、payout_attempts、payout_batches、recon_channel、fee_rules、tax_ytd、fund_ledger；不直接改余额。

## 谁能改

- 风险级 RV2（资金，`ops/risk-map.yaml`）。主实现 Claude 子代理（难任务由编排指定更高档模型，台账 impl 仍写 claude）；规则测试作者 Codex（实现前先写、先红）；Codex 新只读会话对抗评审（money），无未关闭的 S0 / S1 才合并（`ops/approvals.yaml` 第 19、27、34 条）。
- 不变量 SQL 在 `db/invariants/`（保护路径，只能新增），由规则测试作者编写。

## 依据（只写指针，取值与公式只在 08）

| 要查什么 | 看哪里 |
| --- | --- |
| 模块职责、拥有的表、依赖 | 规划/02 §4.1 `payout` 行、§5.3 打款时序、§18 一致性做法 |
| 申请校验顺序、限额、冻结、建单、状态机、分录 | 08 BR-WDR-03～09 |
| 打款通道、结果判定、水位、自动到账 | 08 BR-WDR-12～18、28、30、32、33 |
| 用户侧状态文案 | 08 BR-TEXT-06、BR-WDR-25 |
| 分录模板与凭证键 | `specs/ledger-rules.md`、`specs/ledger-templates.csv`（`WITHDRAW:*`） |
| 表结构 | `db/schema.sql` |
| 拆分方案与决定 | `couli-runs/WITHDRAW-lane/plan.md`（不入库） |

## 硬规则

1. 提现状态只由本模块写，且只调用生成的 `transitionWithdrawal()`；每次迁移用 CAS，影响 0 行视为并发冲突（20902，`data.resource=withdrawal`），不写任何分录。
2. 分录只经 ledger 的 `lockBalances` / `post`，与状态迁移同一事务；冻结金额留在用户 frozen 子户直到终态，不设在途科目。
3. 加锁顺序固定：identity 的 users 行锁 → `ledger.lockBalances` → 收款账号 advisory 锁；锁内复核后才建单。
4. 打款结果未知只查询、不重发；`out_biz_no` 建单时生成、永不修改；只有 payout 进程读通道密钥，非生产环境只用假通道。
5. 幂等落在 PG 唯一约束上（幂等记录与 `out_biz_no`）；任务按至少一次投递写，消费端去重。
6. 金额只经 `@couli/money`；时间只读注入的 `Clock`；日切与自然月只用 `@couli/domain` 的函数。
7. 只读写本模块的表；别的模块的数据只经对方 `index.ts` 导出的端口。只读入口 `read.ts` 只导出列表查询函数（BR-AI-02 ④）。
8. 日志只用 pino，不打收款账号、姓名等个人信息。
