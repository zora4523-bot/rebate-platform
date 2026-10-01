# test/properties：属性测试

放什么：用 fast-check 写的属性测试（分账属性、账务不变量等），一条属性一个顶层 `it`，不套 `describe`（规划/11 §4.3）。

规则（规划/11 §4.2）：

- 次数与种子只从 `@couli/testing` 的 `propParams()` 取（环境变量 `PROP_RUNS`、`PROP_SEED`），测试里不写死。
- 属性体返回布尔；`fc.assert` 之外只做一次汇总断言。
- 生成器统计用 `createPropStats()` 记录并 `flush()` 到 `PROP_STATS_FILE`，不打印到控制台；`fc.pre` 丢弃率低于 10%；金额基数覆盖 0、1、奇数、大于 2^31 四档，每档命中不少于 1%。
- `it.each` 标题不用 `%j` 打印 bigint。

怎么跑：

| 层 | 命令 | 次数 |
| --- | --- | --- |
| `verify:fast` | `pnpm --filter @couli/spec-tests test` | 每条 1 万次（默认） |
| RV2 合并前长跑 | `PROP_RUNS=1000000 pnpm test:longrun` | 每条 100 万次，单测超时 10 分钟 |

`harness.test.ts` 只验证测试底座本身（源码解析、三个环境变量），不含业务规则。

保护规则（规划/11 §4.4 第一类）：本目录**只能新增，不能改删**。要改须单独开 `test-change` 任务，由另一家评审。
