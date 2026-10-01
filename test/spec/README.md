# test/spec：规则测试

放什么：按 08 的 BR 条款逐条写的规则测试（资金、归属、状态机），以及它们用的参考实现（如 `reference/split.ref.ts`）、状态机期望表（`state-machines/<名>.expected.csv`）、打款故障注入集（`payout/`）。测试 ID 与条款一一对应，资金与归属的规则测试由**非实现方**先写、先红（规划/11 §0、§2.3 第 3 步）。

写法：

- 文件名 `*.test.ts`；资金规则测试写顶层 `it`，不套 `describe`（规划/11 §4.3）。
- 不 mock `@couli/money` 和 ledger；不写 `.skip`、`.only`、`retry`；每个测试有断言。
- 这里的测试由 `pnpm --filter @couli/spec-tests test` 运行，属于 `verify:fast`：不连库、不监听端口、不联网。要连真实 PG 的规则测试用 `*.int.test.ts`，接入方式随 B1-01 的测试库底座任务加入。

保护规则（规划/11 §4.4 第一类）：本目录**只能新增，不能改删**。确实要改须单独开 `test-change` 任务，由另一家评审，只接受两种理由：BR 已变更（附变更记录），或测试与 08 不符（附行号）。

现在还没有规则测试：第一批随 10-04 的 `packages/money` 试跑加入（规划/11 §9.2）。
