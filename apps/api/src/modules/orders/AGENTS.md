# apps/api/src/modules/orders（订单：同步、映射、归因、状态）

订单同步任务与水位、平台状态映射、归因流水线（订单唯一键、归因时点、归属判定）、平台状态迁移、来源回填、订单列表与详情、待跟单卡。返利状态（rebate_status）的写者是 settlement，本模块只经端口调用；分佣快照经 commission 的端口生成。

## 谁能改

- 风险级 RV2（订单归属，`ops/risk-map.yaml`）。主实现 Claude Opus 5.5 子代理（本模块在 Codex 实现禁区，`tools/guard/codex-impl-tasks.json`）；规则测试作者 Codex（实现前先写、先红）；Codex 新只读会话对抗评审，无未关闭的 S0 / S1 才合并（`ops/approvals.yaml` 第 19、27、30 条）。
- 实现者只写 `src/**/*.test.ts` 单元测试；规则测试在 `test/spec/orders/**`，实现任务不能改删。

## 依据（只写指针，取值与规则只在 08）

| 要查什么 | 看哪里 |
| --- | --- |
| 模块职责、拥有的表、依赖 | 规划/02 §4.1 `orders` 行 |
| 同步任务、水位、事务粒度、平台状态映射、归因流水线 | 规划/02 §7.1～§7.3；并发与锁 §18 |
| 归属、归因、时间窗口、来源回填、订单唯一键、归因时点 | 08 BR-ATTR-* |
| 双状态模型、平台状态映射、可入账事件 | 08 BR-FUND-01、BR-FUND-02 |
| 状态机 | `specs/state-machines/order-platform.yaml`、`order-rebate.yaml`（生成的 `transition()`） |
| 表结构 | `db/schema.sql`（orders、order_keys、order_rights、order_settlements、sync_cursors、order_sync_*、order_status_history） |
| 接口 | `contracts/openapi.yaml`（tag orders） |

## 硬规则

1. 平台差异止于联盟适配器：本模块只读 union 归一后的订单形状，不按平台解析原始报文。
2. 每个子订单一个事务，事务内先取该子订单的 advisory 锁；判定先于写库，表外事件不落订单的任何列。
3. 订单唯一性最后落在 order_keys 的唯一约束；任务按至少一次投递写，重复投递不产生第二行。
4. 状态字段只经生成的 `transition()` 做 CAS 迁移；不手写状态比较与赋值。
5. 时间只读注入的 `Clock`；会计日、结算月、按月筛选只用 `@couli/domain` 的函数。
6. 金额是整数分，只经 `@couli/money`；本模块不自写分佣或取整。
7. 订单类表只预建分区、不删除行与分区（BR-ID-30）。
8. 只读写本模块的表；别的模块的数据只经对方 `index.ts` 导出的端口。
9. 08 没写清的取值不自定：按任务书写明的默认值实现，并在任务输出里列出。
10. 日志只用 pino，只打平铺字段；不打买家信息与完整订单号。
