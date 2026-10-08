# test/acceptance：验收测试

放什么：与 `规划/10` 的验收用例（AC 编号）一一对应的测试。标题带 `[AC-xxx]`；Then 含多个圈号的用例写成 `[AC-xxx#1]`、`#2`……（规划/11 §4.5）。@auto 用例的验收记录只由脚本从 CI 的 JUnit 生成，不手写。

怎么跑：验收测试要完整的应用与真实 PostgreSQL，只在沙箱外（编排者的 verify 容器或 CI）运行，不进 `verify:fast`。本目录的 `**/*.test.ts` 由 `test/vitest.integration.config.ts` 收进（`acceptance/**/*.test.ts`），经 `test:int`（`pnpm test:int`，或 `pnpm --filter @couli/spec-tests run test:int`）运行；单元配置 `test/vitest.config.ts` 不收本目录。数据库入口是 packages/db 的测试库底座：globalSetup 是源码文件 `packages/db/src/testing/global-setup.ts`，设了 `TEST_PG_ADMIN_URL` 就直连，没设就用 Testcontainers 起一次性库；每个测试文件经 `@couli/db/testing` 的 `createTestDatabase()` 克隆自己的库，只以业务角色连接（用法见 `packages/db/README.md`）。

保护规则（规划/11 §4.4 第一类）：本目录**只能新增，不能改删**。要改须单独开 `test-change` 任务，由另一家评审。PR 改删已有验收测试自动升为 RV2。

现在还没有验收测试。
