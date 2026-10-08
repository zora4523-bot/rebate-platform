# test/spec：规则测试

放什么：按 08 的 BR 条款逐条写的规则测试（资金、归属、状态机），以及它们用的参考实现（如 `reference/split.ref.ts`）、状态机期望表（`state-machines/<名>.expected.csv`）、打款故障注入集（`payout/`）。测试 ID 与条款一一对应，资金与归属的规则测试由**非实现方**先写、先红（规划/11 §0、§2.3 第 3 步）。

写法：

- 文件名 `*.test.ts`；资金规则测试写顶层 `it`，不套 `describe`（规划/11 §4.3）。
- 不 mock `@couli/money` 和 ledger；不写 `.skip`、`.only`、`retry`；每个测试有断言。
- 这里的测试由 `pnpm --filter @couli/spec-tests test` 运行，属于 `verify:fast`：不连库、不监听端口、不联网。要连真实 PG 的规则测试用 `*.int.test.ts`：单元配置不收它们，由 `test/vitest.integration.config.ts`（`spec/**/*.int.test.ts`）收进，经 `test:int`（`pnpm test:int`，或 `pnpm --filter @couli/spec-tests run test:int`）在沙箱外运行。数据库入口读 `TEST_PG_ADMIN_URL`（没设就用 Testcontainers），只在 globalSetup 里读：globalSetup 是 packages/db 的源码文件 `packages/db/src/testing/global-setup.ts`；测试文件经 `@couli/db/testing` 的 `createTestDatabase()` 克隆自己的库，只以业务角色连接（用法见 `packages/db/README.md`）。

保护规则（规划/11 §4.4 第一类）：本目录**只能新增，不能改删**。确实要改须单独开 `test-change` 任务，由另一家评审，只接受两种理由：BR 已变更（附变更记录），或测试与 08 不符（附行号）。

现状：规则测试已按模块分目录（如 `money/`、`platform/`、`db/`、`contracts/`），第一批随 10-04 的 `packages/money` 试跑加入（规划/11 §9.2），之后由各任务的规则测试作者陆续新增。
