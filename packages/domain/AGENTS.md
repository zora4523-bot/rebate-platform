# packages/domain（@couli/domain）

纯函数的业务规则库：分佣拆分、费率、会计日与结算月等。现在是空壳：业务代码只经任务进入（规划/11 §9.2），先有规则测试，再有实现。

## 谁能改

- 风险级 RV2（资金与归属）。主实现 Claude Opus 5.5 子代理；规则测试作者 Codex（实现前先写、先红）；Codex 新只读会话对抗评审无未关闭的 S0 / S1 才合并（规划/11 §1.1、§3.2；`ops/approvals.yaml` 第 27 条起不再另加 Claude 评审）。
- 实现者只写 `src/**/*.test.ts` 单元测试；规则测试在 `test/spec/`、`test/properties/`，实现任务不能改删（规划/11 §4.4）。
- 会计日与结算月只能由本包的 `accountingDate(instant)`、`settlePeriod(instant)` 得出，其他地方不得自己换算（规划/11 §4.2「时钟」）。这两个函数尚未实现，由任务加入。
- 实体主键 UUIDv7 由本包生成（ADR-0001 §4.2 第 1 项），同样由任务加入。

## 动手前先读（取值与公式只在 08，这里不复述）

| 主题 | 看哪里 |
| --- | --- |
| 金额与比例的类型 | BR-CALC-01 |
| 舍入与尾差 | BR-CALC-08 |
| 分账属性与算例表 | BR-CALC-21；规划/11 §4.2「分账属性至少包含」 |
| 会计日、结算月、记账时刻 | 规划/11 §4.2「时钟」；ADR-0001 §4.2 第 21 项；任务书列出的 BR-FUND 条目 |

任务书里已按 `SPEC_REF` 抽好原文；与契约或 ADR-0001 冲突时停下，在输出的 `blocked_reason` 里写明。

## 硬规则

1. 金额只用 `bigint`，金额运算只调用 `@couli/money`；不出现 `number` 金额与浮点。
2. 纯函数：不读环境变量、不做 I/O、不依赖 Nest、数据库、队列。
3. 禁用 `new Date(`、`Date.now(`、`toISOString().slice`：时刻由调用方经 `Clock` 取得后作为参数传入（守卫检查，规划/11 §4.2）。
4. 只用可擦除的 TS 语法；相对导入带 `.ts` 后缀；对外只从 `src/index.ts` 导出。
5. 依赖方向：本包只能依赖 `@couli/money`；`@couli/testing`、`fast-check` 只在测试里用。

## 测试

- 规则测试一律写顶层 `it`，不套 `describe`（规划/11 §4.3）；本包 `src/` 下的单元测试同样不套。
- 属性测试的次数与种子只从 `@couli/testing` 的 `propParams()` 取；属性体返回布尔，`fc.assert` 之外只做一次汇总断言；生成器统计用 `createPropStats()` 写文件。
- 涉及时间的规则按时刻矩阵各跑一遍：月末最后一毫秒、月初零点、北京时间早 8 点前（规划/11 §4.2）。
- 规则测试里不得 mock `@couli/money`。不写 `.skip`、`.only`、`retry`；每个测试都有断言。

## 命令

| 用途 | 命令 |
| --- | --- |
| 本包单元测试 | `pnpm --filter @couli/domain test` |
| 规则与属性测试 | `pnpm --filter @couli/spec-tests test` |
| 长跑（每条属性 100 万次） | `PROP_RUNS=1000000 pnpm test:longrun` |
| 类型检查 | `pnpm exec tsc -b packages/domain` |
