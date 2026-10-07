# staging 部署底座（B1-01zc）

一个后端镜像 `couli-api:<标签>` 跑五个常驻进程（api / stream / worker / admin / payout）和一次性的迁移步骤。镜像在开发机构建，传到节点后由 `deploy.sh` 部署：先迁移、再切换五个进程并等健康检查，失败就回到上一个成功的标签。

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 多阶段镜像：Node 24，按 `pnpm-lock.yaml` 离线安装，构建 `@couli/api`；运行阶段用非 root 用户 `node` |
| `compose.yaml` | 五个服务，同一个镜像，`command` 选入口；只用 `image:`，不构建、不拉取 |
| `deploy.sh` | 部署与回退脚本，参数是镜像标签 |
| `../../.dockerignore` | 构建上下文排除环境文件、`.git`、`node_modules`、构建产物 |

## 1. 首次准备（节点上，一次）

环境文件由负责人 / 编排者直接放在节点上，**不进仓库、不进镜像**，属主 root、权限 600：

| 文件 | 给谁用 | 内容（只列变量名） |
| --- | --- | --- |
| `/etc/couli/staging.env` | api、stream、worker、admin | APP_ENV、API_PORT / STREAM_PORT / ADMIN_PORT、DATABASE_URL、DATABASE_READ_URL、DATABASE_MAINT_URL、REDIS_URL |
| `/etc/couli/staging-payout.env` | 只给 payout | payout 自己的 DATABASE_URL（payout 不连 Redis，ADR-0001 §4.2 第 20 项） |
| `/etc/couli/staging-migrator.env` | 只给迁移步骤 | MIGRATOR_DATABASE_URL |

注意事项：

- 进程跑在容器的桥接网络里，连接串里的主机要写节点的内网地址（数据库走 HAProxy 5433 主 / 5434 只读，Redis 走内网地址），不能写 `127.0.0.1`。
- 端口变量不写时用应用默认值（3100 / 3101 / 3102）；三个 HTTP 端口只发布到节点的 `127.0.0.1`，worker 与 payout 不发布端口。
- 部署文件放在节点的一个目录里（例如 `/opt/couli/staging/`），`compose.yaml` 与 `deploy.sh` 放在同一目录；`deploy.sh` 按自身位置找 `compose.yaml`。
- 上一次成功的标签记在 `/var/lib/couli/staging-api.tag`，脚本会自动创建这个目录和文件。

## 2. 在开发机构建并传到节点

在代码仓库根目录：

```sh
TAG=$(git rev-parse --short=12 HEAD)
docker buildx build --platform linux/amd64 -f infra/staging/Dockerfile -t couli-api:$TAG --load .
docker save couli-api:$TAG | gzip | ssh <staging 节点> 'gunzip | docker load'
scp infra/staging/compose.yaml infra/staging/deploy.sh <staging 节点>:/opt/couli/staging/
```

标签用提交号，不用 `latest`。节点连不上 Docker Hub 以外的部分源，所以镜像一律在开发机构建后 `docker save | ssh … docker load` 传过去，节点上不构建、不拉取（compose 里 `pull_policy: never`）。

## 3. 部署

在节点上以 root 运行：

```sh
/opt/couli/staging/deploy.sh <标签>
```

脚本依次打印每一步结果：

1. 检查镜像已经 `docker load` 到节点；
2. 用新镜像一次性运行迁移（`node packages/db/scripts/migrate.ts`，只读 `staging-migrator.env`），迁移失败直接停下，正在运行的进程不受影响；
3. `docker compose up -d --force-recreate --wait` 重建全部五个进程，等 api / stream / admin 的 `/healthz` 健康检查通过（上限 180 秒）；
4. 成功后把新标签写入 `/var/lib/couli/staging-api.tag`。

脚本不打印任何环境文件的内容，也不开启命令跟踪。

## 4. 回退

- **自动回退**：第 3 步健康检查不通过时，脚本把五个进程切回状态文件里记录的上一个成功标签，再等一次健康检查，然后以非零退出。首次部署没有上一个标签，脚本只报错退出，容器保留用于排查。
- **手动回退**：直接用旧标签再部署一次，`deploy.sh <旧标签>`。
- 迁移只向前执行，回退不会撤销已经执行的迁移；新迁移必须与上一个版本的代码兼容（先加后删）。

## 5. 看状态与日志

```sh
cd /opt/couli/staging
docker compose -f compose.yaml --env-file /etc/couli/staging.env ps
docker compose -f compose.yaml --env-file /etc/couli/staging.env logs --since 30m api
cat /var/lib/couli/staging-api.tag
```

`docker compose` 需要 `COULI_API_TAG` 才能解析镜像名，手工执行前先 `export COULI_API_TAG=$(cat /var/lib/couli/staging-api.tag)`。日志用 json-file 驱动，每个容器最多保留 5 个 20 MB 的文件。
