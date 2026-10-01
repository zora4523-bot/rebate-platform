# 本地开发栈（infra/local）

`compose.yaml` 是本机开发用的 PostgreSQL 18 + pgvector 和 Redis（ADR-0001 §4.2 第 12、17 项）。compose 项目名 `couli-local`，端口只绑 127.0.0.1。

| 服务 | 镜像 | 宿主端口 | 说明 |
| --- | --- | --- | --- |
| postgres | `pgvector/pgvector:0.8.6-pg18-trixie` | 54329 | 数据卷 `couli-local_pgdata`，挂在 `/var/lib/postgresql`；库名 `couli` |
| redis | `redis:7.4.11-alpine` | 63790 | `maxmemory 256mb`、`maxmemory-policy noeviction`，不落盘 |

## 命令（在仓库根目录）

| 用途 | 命令 |
| --- | --- |
| 启动并初始化（建角色、建库、迁移、分区、种子，最后自检） | `pnpm dev:stack` |
| 停止并删除容器（保留数据卷） | `pnpm dev:stack:down` |
| 连数据卷一起删（重置本地库） | `pnpm --filter @couli/db run dev:stack:down --volumes` |

## 要知道的事

- 本地密码取环境变量 `COULI_DB_LOCAL_PASSWORD`，默认 `couli_local`，超级用户和五个业务角色共用，只用于本机。超级用户密码只在数据卷第一次初始化时写入；之后改了这个变量，要先带 `--volumes` 重置。
- 连接串：`postgres://couli_app:<密码>@127.0.0.1:54329/couli`（迁移用 `couli_migrator`）；Redis `redis://127.0.0.1:63790`。
- 测试和 verify 不用这套栈：它们每次起一次性的 PostgreSQL（ADR-0001 §4.2 第 9 项）。不要把 `TEST_PG_ADMIN_URL` 指到这里。
- Codex 沙箱内连不到这套栈（规划/11 §2.4），只由编排者或负责人在沙箱外启动。
- MinIO、Prism、WireMock 还没有加，见 `compose.yaml` 里的 TODO。
