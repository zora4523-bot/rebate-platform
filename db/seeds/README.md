# db/seeds

种子数据放这里（ADR-0001 §4.2 第 12 项）：首行 `app_id`、平台字典、开关默认值、本地超管。**现在还没有种子文件**：对应的表（`apps`、字典表、配置表、后台账号）要等基线表结构任务（10-06～08）建好才有。

到时候的约定：

- 文件名 `NNNN_kebab-name.sql`，按文件名顺序执行；由 `pnpm db:seed`（`packages/db/scripts/seed.ts`）以 `couli_migrator` 身份逐个在事务里执行。
- 必须可重复执行（`INSERT … ON CONFLICT DO NOTHING` 之类），`pnpm dev:stack` 每次都会跑。
- 只放合成数据；真实账号、密钥、风控参数不进本仓库（规划/11 §8）。
- 种子不是迁移：改表结构只能走 `db/migrations/`。
