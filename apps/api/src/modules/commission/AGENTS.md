# apps/api/src/modules/commission（资金：返利规则与报价）

返利规则版本（含每个平台的预留比例）、真实返利报价器；后续加分佣快照。无 HTTP 入口（后台规则发布接口另由任务加入）。

## 谁能改

- 风险级 RV2（资金，`ops/risk-map.yaml`）。主实现 Claude Opus 5.5 子代理；规则测试作者 Codex（实现前先写、先红）；Codex 新只读会话对抗评审，无未关闭的 S0 / S1 才合并（`ops/approvals.yaml` 第 19、27 条）。
- 实现者只写 `src/**/*.test.ts` 单元测试；规则测试在 `test/spec/commission/**`，实现任务不能改删。

## 依据（只写指针，取值与公式只在 08）

| 要查什么 | 看哪里 |
| --- | --- |
| 模块职责、拥有的表、依赖 | 规划/02 §4.1 `commission` 行 |
| 规则版本、比例维度、上限、生效时点 | 08 BR-CALC-05、06、07、11、22 |
| 分佣基数、分账、报价 | 08 BR-CALC-02、04、20、24；报价展示 BR-PRICE-06～09 |
| 表结构 | `db/schema.sql`（commission_rule_versions、commission_rules、commission_rule_reserves） |

## 硬规则

1. 金额与比例只经 `@couli/money` 与 `@couli/domain`（splitCommission、quoteRebate）；本模块不自写取整、比例换算或分账。
2. 平台口径差异只在 union（quoteN）；本模块不按平台分支算钱。
3. 只读写本模块的表；别的模块的数据只经对方 `index.ts` 导出的端口。
4. 时间只读注入的 `Clock`；按时刻选规则版本，不用 SQL 时钟。
5. 读不到版本、版本缺行、配置缺失或不合法：报价失败（抛错），不按 0、不回退别的版本或默认值。
6. 开放（linking open）事务内只答预读值，不另借数据库连接。
7. 状态字段（版本 status）只经生成的 `transition()`；生成器合并前不在本模块写状态。
8. 日志只用 pino，不打金额以外的个人信息。
