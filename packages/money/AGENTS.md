# packages/money（@couli/money）

金额与比例的唯一运算库。现在是空壳：业务代码只经任务进入（规划/11 §9.2 的 10-04 试跑），先有规则测试，再有实现。

## 谁能改

- 风险级 RV2（资金）。主实现 Codex；规则测试作者 Claude；两家评审都无未关闭的 S0 / S1 才合并（规划/11 §1.1、§3.2）。
- 实现者只写 `src/**/*.test.ts` 单元测试；规则测试在 `test/spec/`、`test/properties/`，实现任务不能改删（规划/11 §4.4）。
- 本包是金额运算的单一写者：其他包和模块不得自己实现取整、比例换算、金额格式化，一律调用本包。

## 动手前先读（取值与公式只在 08，这里不复述）

| 编号 | 管什么 |
| --- | --- |
| BR-CALC-01 | 金额与比例的数据类型、允许的运算入口 |
| BR-CALC-08 | 舍入方向与尾差归属 |

任务书里已按 `SPEC_REF` 抽好原文；与契约或 ADR-0001 冲突时停下，在输出的 `blocked_reason` 里写明。

## 硬规则

1. 金额只用 `bigint`（单位分），比例只用整数万分之一；不出现 `number` 金额、浮点运算、`parseFloat`、`toFixed`、`Math.round`。
2. 纯函数：不读环境变量、不做 I/O、不依赖 Nest、数据库或其他业务包。
3. 不用 `Date`、`Date.now()`、`new Date()`；本包不需要时间。
4. 只用可擦除的 TS 语法（不用 `enum`、`namespace`、参数属性、装饰器）；相对导入带 `.ts` 后缀。
5. 对外只从 `src/index.ts` 导出；不加默认导出。
6. 序列化到 JSON 的金额必须先断言不超过 2^53−1（ADR-0001 §4.2 第 3 项）。

## 测试

- 资金规则测试一律写顶层 `it`，不套 `describe`（规划/11 §4.3）；本包 `src/` 下的单元测试同样不套。
- 属性测试的次数与种子只从 `@couli/testing` 的 `propParams()` 取；属性体返回布尔，`fc.assert` 之外只做一次汇总断言；生成器统计用 `createPropStats()` 写文件。
- `it.each` 的标题不用 `%j` 打印 bigint。
- 不写 `.skip`、`.only`、`retry`；每个测试都有断言。

## 命令

| 用途 | 命令 |
| --- | --- |
| 本包单元测试 | `pnpm --filter @couli/money test` |
| 规则与属性测试 | `pnpm --filter @couli/spec-tests test` |
| 长跑（每条属性 100 万次） | `PROP_RUNS=1000000 pnpm test:longrun` |
| 类型检查 | `pnpm exec tsc -b packages/money` |
