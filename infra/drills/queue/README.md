# 本地队列中断演练

只由编排者在隔离环境执行。需要 Node 24、已安装的仓库依赖，以及已由 `pnpm dev:stack`
初始化的本地栈；本目录不会安装依赖、启动整个栈或读取 `.env` 文件。

在仓库根目录运行（运行目录必须是仓库以外的绝对路径）：

```bash
node infra/drills/queue/cli.ts --scenario worker-stop --runs-dir /absolute/path/couli-runs
node infra/drills/queue/cli.ts --scenario worker-kill --runs-dir /absolute/path/couli-runs
node infra/drills/queue/cli.ts --scenario queue-disconnect --runs-dir /absolute/path/couli-runs
node infra/drills/queue/cli.ts --scenario redis-down --runs-dir /absolute/path/couli-runs
```

`--jobs 20` 是默认值，表示中断前、期间各入队 20 条，允许 1–500。退出码 0 表示通过，
1 表示失败；标准输出给出记录位置。记录包含步骤、发送 ID、问题、重投数及开始/结束时刻，
不会包含连接串、原始驱动异常或凭据。记录同名时拒绝覆盖。

默认 `APP_ENV=local`，固定连接 `127.0.0.1:54329`，本地密码取
`COULI_DB_LOCAL_PASSWORD`（未设置时用 compose 的本地默认值）。不使用 `DATABASE_URL`、
`PG_ADMIN_URL` 或 `REDIS_URL`。前三种场景也支持 `APP_ENV=test` 和回环地址的
`TEST_PG_ADMIN_URL`；测试集群须已安装仓库角色 `couli_app`、`couli_payout`，账号须能建库、
删库及终止自己的连接。拒绝远程地址、连接串查询参数及 staging/prod 环境。

每次创建独立 `qa05b_<随机值>` 数据库，用已提交的 pg-boss 迁移建队列表，运行时设置
`migrate:false`。业务事件与入队在同一事务中提交；独立演练消费者以 PG 联合主键
`(consumer, event_id)` 去重，去重标记与效果在同一语句提交。效果表不对事件 ID 加唯一约束，
因此能够观察到消费端去重失效时的重复效果。这里验证真实 pg-boss 与演练消费者的恢复路径，
不代表已经验证所有业务模块的消费者。

第一次消费在效果提交后、队列确认前等待：正常停机释放等待并退出；强杀使用 SIGKILL，
等待 30 秒租约过期后由 pg-boss 重投，且要求确实观察到至少一次重投；断线只终止该临时库中
标记为当前 worker 的 PG 连接，不重启进程。中断期间入队一次，恢复后不补投。

Redis 场景只用于本地 compose 栈，通过本机 Unix socket 操作 `couli-local` 项目的 Redis，
开始前要求 Redis 正常运行，并用咨询锁串行化此场景。停 Redis 后释放消费者，必须在恢复 Redis
前排空；超时证据不会因 Redis 恢复而消失。它会暂时影响共享本地栈的缓存使用者。

正常结束或步骤失败后，停止本次子进程、恢复 Redis、关闭连接并删除本次临时数据库，
清理失败也判失败。SIGINT/SIGTERM 会走失败记录与清理流程。若宿主崩溃或父进程被 SIGKILL，
初始记录保留 `ok:false/status:running` 与临时库名；编排者须核对该记录，恢复本地 Redis，
再清理记录中指明的临时库。

冻结规则测试位于 `test/spec/drills/queue/`。沙箱内只做 `pnpm typecheck`、`pnpm lint`；
规则测试与上面的实际故障演练由编排者在容器或 CI 中验证。
