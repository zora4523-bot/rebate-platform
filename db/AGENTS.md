# AGENTS.md（db/）

数据库规则的摘要；正文在规划仓库 `docs/adr/0001-技术栈基线.md` §4 和 `规划/02` §18、§19。

## 目录

| 路径 | 内容 | 谁能改 |
| --- | --- | --- |
| `bootstrap/roles.sql`、`bootstrap/extensions.sql` | 五个角色、扩展；超级用户每个环境执行一次，不是迁移 | 迁移任务 |
| `migrations/NNNN_kebab-name.sql` | SQL 迁移，分区表与普通表同一序列 | 迁移任务（RV2） |
| `schema.sql` | 表结构快照，**生成物**，表结构的唯一来源 | 只由 `pnpm db:snapshot` 生成 |
| `seeds/` | 种子（现在为空） | 见 `seeds/README.md` |
| `invariants/` | 不变量 SQL，保护路径：只能新增 | 规则测试作者 |

## 迁移规则

1. 文件名四位序号加短横线名字，首行 `-- Up Migration`，不写 down 段；恢复方式写在文件头注释里。
2. **已经合并的迁移永远不改**，要改就写新迁移。
3. 先扩展、再回填、再收缩：加列或加表 → 回填 → 下一个发布再删旧的。一个迁移不同时做扩展和收缩。
4. 授权写在创建对象的同一个迁移里；业务角色只拿用得到的权限。只追加的表不给 UPDATE / DELETE。
5. 迁移里不写依赖日期的 DDL：只建 DEFAULT 分区，月分区由 `app.ensure_month_partition` 在运行时建（`pnpm db:partitions`）。新增按月分区的表时，在同一个迁移里把表名加进该函数的允许名单，并同步 `packages/db/src/partitions.ts`。
6. 列默认值不得写 `uuidv7()`（PG 17 没有）；UUIDv7 由应用生成。除 `created_at`、`updated_at` 的默认值外不用 SQL 时钟。
7. 业务表放 schema `app`，带 `app_id NOT NULL`；金额 `bigint` 分（`_fen`），比例万分之一（`_bp`）；保留外键、禁止级联；分区表不作外键目标。
8. 触发器只允许「禁止 UPDATE / DELETE」这一类；不用存储过程写业务逻辑。
9. 扩展由超级用户在 `bootstrap/extensions.sql` 里建，迁移里不写 `CREATE EXTENSION`。
10. `0002_pgboss-schema-v42.sql` 是生成物（`pnpm --filter @couli/db run gen:pgboss`）。升级 pg-boss 的 `deps` 任务必须同时带一个取自 `getMigrationPlans` 的新迁移（ADR-0001 §4.2 第 14 项）。
11. 迁移 SQL 过 squawk（CT-06a）：`pnpm run lint:migrations`（在 `verify:fast` 里），规则与排除项见根目录 `.squawk.toml`；0001–0018 与门禁合并前已合并的 0019_device-registrations-created-at-insert.sql 早于门禁，冻结不检查（基线与冻结清单写在 `tools/ci/lint-migrations.ts`）。新迁移开头先写 `SET LOCAL lock_timeout` 与 `SET LOCAL statement_timeout`（值按本迁移的操作定并注释）。资金与归属表（订单、账本、账户、提现、打款、结算、分佣、对账、调账、联盟绑定与推广位、转链等，清单在该脚本里）不得 DROP、改类型、RENAME，也不接受任何 `squawk-ignore`（规划/02 §16.3）；其他表确需这样做时，在该语句的上一行写 `-- squawk-ignore <规则名>`，原因写在它上面的注释里（忽略注释与语句之间不能隔别的行）。金额列 `*_fen` 只能是 bigint，脚本自己检查（也不能靠改名或 `CREATE TABLE … AS` / `SELECT … INTO` 产出）；文件级 `squawk-ignore-file` 一律拒绝。两项超时须大于 0，文件里任何位置的 `RESET` 或置 0 / DEFAULT 都算没设。冻结迁移按文件名与内容哈希核对（`FROZEN_MIGRATIONS`），新迁移取下一个空号，迁移只写 SQL。破坏性 DDL（DROP、RENAME、TRUNCATE、改类型）不要写进 `DO` 块，资金与归属表不得 `SET SCHEMA`（CT-06b）。资金表上的触发器、约束、索引只能在同一迁移里按同名重建，不得只删或停用；不接受 `DROP … CASCADE`；资金表触发器所执行的函数不得删除、改名、改属主或改模式（CT-06c；替换它见下句）。资金表保护对象（触发器函数、触发器、约束、索引）的定义一旦变化——CREATE OR REPLACE 资金表触发器函数、按同名重建但定义不同、原地 CREATE OR REPLACE TRIGGER——迁移须登记在 `tools/ci/lint-migrations.ts` 的 `APPROVED_GUARD_CHANGES`（文件名与 sha256，两家评审加批准标签），定义完全相同的重建照常放行；资金表索引、触发器、约束不得改名，触发器不得设为 REPLICA。pg-boss 升级生成器（`packages/db/scripts/gen-pgboss-migration.ts`）的输出须按本条改写：结尾不要把 lock_timeout 恢复为 DEFAULT，DO 块里不要放 DROP（CT-06d）。资金与归属表上的约束和索引必须写明名字（`CONSTRAINT <名>`、`CREATE INDEX <名>`），否则后续迁移无法与原定义比对；按同名重建时照原定义写；squawk 会以 `constraint-missing-not-valid` 拦下不带 NOT VALID 的重建，这时在该 ALTER TABLE 语句上一行写 `-- squawk-ignore constraint-missing-not-valid`（只此一条规则；该语句只按原定义加回同名约束，删除写在同一语句或本迁移更早的 ALTER TABLE 里，可分行写），门禁核实定义与迁移史相同后放行（CT-06g）。`set_config` 设超时只写字符串字面量。门禁按 PostgreSQL 的读法解码 `E'…'`、`U&'…'` 与美元引号字面量，含门禁不认识的转义的超时取值按「没设」处理；`set_config` 关超时在语句任何位置都算。DO 块里不要替换或删除触发器、函数、过程、索引，也不要删约束、停用触发器或建未命名的资金表索引，DO 正文与 EXECUTE 字符串里不要用门禁不认识的转义，这些都写成普通 SQL（CT-06f）。

## 生成物不手改

`schema.sql`、`packages/db/src/db.gen.ts`、`migrations/0002_pgboss-schema-v42.sql` 都由脚本生成；`pnpm db:check` 比对漂移。

## 含迁移的任务拆两段（规划/11 §2.3）

实现子代理不连库（Codex 沙箱里也连不上），迁移和类型生成只由编排者在沙箱外跑：

1. 实现者只写迁移 SQL，输出里用 `outside_needed` 写明要跑 `pnpm db:snapshot`。
2. 编排者在沙箱外跑迁移、快照、类型生成并提交生成物。
3. 再派实现者基于已生成的类型写代码。

## 命令（仓库根目录，都要在沙箱外跑）

| 用途 | 命令 |
| --- | --- |
| 重新生成 `schema.sql` 与 `db.gen.ts` | `pnpm db:snapshot` |
| 漂移检查 | `pnpm db:check` |
| 集成测试（一次性 PG） | `pnpm test:int` |
| 本地栈 | `pnpm dev:stack` |
