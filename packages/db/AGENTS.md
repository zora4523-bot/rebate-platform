# AGENTS.md（packages/db）

数据库访问包。迁移规则在 `db/AGENTS.md`，用法和命令在本目录 `README.md`。

## 规则

1. `src/db.gen.ts` 是生成物，不手改；改表结构只能加迁移，然后在沙箱外跑 `pnpm db:snapshot`。实现任务需要它时在输出里写 `outside_needed`。
2. 业务代码只从 `@couli/db` 取 `createDb`、类型 `DB` 和纯函数；连接池、`pg` 细节不外泄到模块里。
3. 所有业务表在 schema `app`，`createDb()` 返回的实例已经 `.withSchema('app')`；手写 SQL 要写全 `app.<表>`。
4. int8 一律是 `bigint`（BigInt），不转 `number`，不用字符串。
5. 单元测试（`src/**/*.test.ts`）不连库、不引用 `src/testing/` 和 testcontainers；连库的测试写成 `*.int.test.ts`。
6. 集成测试只以业务角色连接（`urlFor('couli_app')` 等），不得绕到超级用户；`TEST_PG_ADMIN_URL` 只有 globalSetup 能读。
7. `src/testing/**` 是测试基础设施：改它会影响所有集成测试，按门禁改动对待，实现任务不顺手改。
8. 新增按月分区的表：迁移里把表名加进 `app.ensure_month_partition` 的允许名单，同时改 `src/partitions.ts` 的 `MONTH_PARTITIONED_TABLES`（单元测试会比对两处）。
9. pg-boss 只在这里和 platform 模块出现；业务代码依赖自有的 `JobQueue` 接口（ADR-0001 §2）。进程一律 `migrate:false`。
10. 这里不写业务逻辑，也不替业务取当前时间：纯函数的时间由调用方传入；只有 `scripts/partitions.ts` 和测试基础设施的计时读系统时钟。

## 沙箱内能跑的

`pnpm --filter @couli/db test`、`pnpm exec tsc -b packages/db packages/db/scripts`、`pnpm --filter @couli/db run gen:pgboss -- --check`。其余命令都要数据库或 Docker。
