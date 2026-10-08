# staging 部署底座（B1-01zc）

一个后端镜像 `couli-api:<标签>` 跑五个常驻进程（api / stream / worker / admin / payout）和一次性的迁移步骤。镜像在开发机构建，传到节点后由 `deploy.sh` 部署：先迁移、再切换五个进程并等健康检查，失败就回到上一个成功的标签。

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 多阶段镜像：Node 24，按 `pnpm-lock.yaml` 离线安装，构建 `@couli/api`；运行阶段用非 root 用户 `node` |
| `compose.yaml` | 五个服务，同一个镜像，`command` 选入口；只用 `image:`，不构建、不拉取 |
| `boot.mjs` | 五个进程启动时先加载（`node --import`）：记录容器启动次数供健康检查用；api 从挂载文件读签名私钥 |
| `deploy.sh` | 部署与回退脚本，参数是镜像标签 |
| `../../.dockerignore` | 构建上下文排除环境文件、证书与密钥文件、SSH 私钥、`.git`、`node_modules`、构建产物 |

## 1. 首次准备（节点上，一次）

环境文件由负责人 / 编排者直接放在节点上，**不进仓库、不进镜像**，属主 root、权限 600：

| 文件 | 给谁用 | 内容（只列变量名） |
| --- | --- | --- |
| `/etc/couli/staging.env` | api、stream、worker、admin | API_PORT / STREAM_PORT / ADMIN_PORT、DATABASE_URL、DATABASE_READ_URL、DATABASE_MAINT_URL、REDIS_URL、FIELD_KEY_PROVIDER、FIELD_KEYRING_FILE、FIELD_MASTER_KEY_FILE |
| `/etc/couli/staging-payout.env` | 只给 payout | payout 自己的 DATABASE_URL，以及同样的三个 FIELD_* 变量（payout 不连 Redis，ADR-0001 §4.2 第 20 项） |
| `/etc/couli/staging-migrator.env` | 只给迁移步骤 | MIGRATOR_DATABASE_URL |

`APP_ENV` 不放在环境文件里：`compose.yaml` 给五个服务都直接写死 `APP_ENV: staging`（它不是口令）。三个环境文件里都**不要**写 JWT_ 开头的变量：签名私钥与 kid 只给 api，经 1.4 的挂载文件注入（stream / worker / admin 共用 `staging.env`，只有 kid 没有私钥会被拒绝启动）。

`deploy.sh` 在迁移之前检查下面这些节点文件都存在（只看是否存在，不读内容），缺任何一个直接报错退出，不迁移、不碰正在运行的进程：三个环境文件、`/etc/pki/ca.crt`、`/etc/couli-keys/master.key` 与 `keyring.json`、`/etc/couli-jwt/es256.pem` 与 `key-id`。

注意事项：

- 进程跑在容器的桥接网络里，连接串里的主机要写节点的内网地址（数据库走 HAProxy 5433 主 / 5434 只读，Redis 走内网地址），不能写 `127.0.0.1`。
- 端口变量不写时用应用默认值（3100 / 3101 / 3102）；三个 HTTP 端口只发布到节点的 `127.0.0.1`，worker 与 payout 不发布端口。
- 部署文件放在节点的一个目录里（例如 `/opt/couli/staging/`），`compose.yaml` 与 `deploy.sh` 放在同一目录；`deploy.sh` 按自身位置找 `compose.yaml`。
- 上一次成功的标签记在 `/var/lib/couli/staging-api.tag`，脚本会自动创建这个目录和文件。
- 同一时间只允许一次部署：脚本用 `flock` 锁住 `/run/lock/couli-staging-deploy.lock`，拿不到锁直接非零退出。

### 1.1 数据库证书（自签）

数据库用自签证书，CA 放在节点的 `/etc/pki/ca.crt`。五个服务和迁移容器都把它只读挂到容器内同一路径。三个环境文件里的数据库连接串末尾都要带 `?sslmode=verify-ca&sslrootcert=/etc/pki/ca.crt`（已有查询参数时用 `&` 接上）。

**迁移连接串还要多带一个 `&uselibpqcompat=true`**（只加在 `staging-migrator.env` 的 MIGRATOR_DATABASE_URL 上）。迁移经 pg-connection-string 2.x 解析连接串，它默认把 `verify-ca` 当成 `verify-full`，会校验证书里的主机名；staging 按内网 IP 连 HAProxy，证书不一定写了这个 IP，迁移就会报 `ERR_TLS_CERT_ALTNAME_INVALID`。带上这个参数后按 libpq 的 `verify-ca` 语义：校验 CA，不校验主机名。**应用的连接串不要加**：应用自己处理 `verify-ca`，它的参数白名单也不收这个参数。`deploy.sh` 在迁移前检查：迁移环境文件里有 `sslmode=verify-ca` 却没有 `uselibpqcompat=true` 时直接报错退出（只做匹配判断，不打印文件内容）。

### 1.2 环境文件的写法

- 每行写成「变量名=值」，值不加引号。口令里若有 `@ / ? # :` 等字符要先 percent 编码（日志打码按标准写法识别口令）。`compose.yaml` 用 `format: raw` 读取服务的环境文件，值里的 `$` 不会被展开。
- `deploy.sh` 还会用 `--env-file /etc/couli/staging.env` 让 Compose 读出端口号，这一步会对整个文件做 `$` 展开（可能把 `$` 后面的字符当变量名打印成警告）。所以**口令只用字母和数字**；节点上现有口令已经是字母数字。

### 1.3 字段加密密钥环（ADR-0003）

五个服务都把节点目录 `/etc/couli-keys` 只读挂到容器内 `/run/couli-keys`。注意不是 `/etc/couli/keys`：规则测试禁止任何服务挂载 `/etc/couli` 下的路径（那里放着环境文件），所以密钥单独放在 `/etc/couli-keys`。

两个环境文件（`staging.env` 与 `staging-payout.env`）都要写：

| 变量 | 值 |
| --- | --- |
| FIELD_KEY_PROVIDER | `local` |
| FIELD_KEYRING_FILE | `/run/couli-keys/keyring.json` |
| FIELD_MASTER_KEY_FILE | `/run/couli-keys/master.key` |

首次生成（节点上以 root 执行一次；`keyring-init.ts` 由任务 B1-01zd 提供，文件格式以它为准）：

```sh
install -d -m 700 /etc/couli-keys
(umask 077 && openssl rand -hex 32 > /etc/couli-keys/master.key)
docker run --rm --pull never --network none --user 0 \
  --volume /etc/couli-keys:/keys couli-api:<标签> \
  node apps/api/scripts/keyring-init.ts /keys/master.key /keys/keyring.json
chown -R 1000:1000 /etc/couli-keys
chmod 400 /etc/couli-keys/master.key /etc/couli-keys/keyring.json
chmod 500 /etc/couli-keys
```

`keyring-init.ts` 的两个参数都是**文件路径**（主密钥文件、输出的密钥环文件），由程序自己读主密钥文件。任何地方都不要用命令替换把主密钥内容放进命令行参数或环境变量：那样它会出现在进程列表和 `docker inspect` 里，文件权限挡不住。若 B1-01zd 的接口只收主密钥内容，要先让它改为收文件路径再做这一步。

容器以 `node` 用户（uid 1000）运行，所以目录和文件属主是 1000，目录 500、文件 400。主密钥丢失后已加密的字段无法解开，生成后另行离线备份。

### 1.4 访问令牌签名私钥（api 专用）

api 在 staging 必须有 ES256 签名私钥（P-256，PKCS#8 PEM）和 kid，否则启动即退出。私钥不放环境文件（`format: raw` 的环境文件放不了多行值，规则测试也只允许每个服务一个环境文件），而是放在节点目录 `/etc/couli-jwt`，只读挂给 api（容器内 `/run/couli-jwt`）。api 启动时由 `boot.mjs` 把两个文件读进本进程的环境变量 JWT_PRIVATE_KEY_PEM 与 JWT_KEY_ID：私钥不进命令行、不进 `docker inspect`、不打印；读不到就报错（只报路径与错误码）并退出。

| 文件 | 内容 |
| --- | --- |
| `/etc/couli-jwt/es256.pem` | PKCS#8 格式（首行标签是 `BEGIN PRIVATE KEY`，不带 `EC`）的 P-256 私钥；`openssl ecparam` 默认写出的 SEC1 格式（`EC PRIVATE KEY`）会被拒绝 |
| `/etc/couli-jwt/key-id` | kid，一行，只能用字母、数字和 `.` `_` `~` `-`，1 到 64 个字符；用环境加年月，例如 `staging-2026-10`，换私钥时换新的 kid |

由节点上已有的 `/etc/couli/jwt/es256.pem` 生成（以 root 执行一次；输出直接写文件，私钥不经过终端）：

```sh
install -d -m 700 /etc/couli-jwt
(umask 077 && openssl pkcs8 -topk8 -nocrypt -in /etc/couli/jwt/es256.pem -out /etc/couli-jwt/es256.pem)
printf '%s\n' staging-2026-10 > /etc/couli-jwt/key-id
chown -R 1000:1000 /etc/couli-jwt
chmod 400 /etc/couli-jwt/es256.pem /etc/couli-jwt/key-id
chmod 500 /etc/couli-jwt
```

`openssl pkcs8 -topk8` 对 SEC1 与 PKCS#8 输入都输出 PKCS#8。核对曲线用 `openssl pkey -in /etc/couli-jwt/es256.pem -noout -text_pub`（只打印公钥，应看到 `prime256v1` 或 `P-256`），不要用会打印私钥的 `-text`。

### 1.5 B1-01zd 之前

**B1-01zd 合并之前**，应用在 `APP_ENV=staging` 下仍拒绝 `FIELD_KEY_PROVIDER=local`，五个进程都会启动失败，部署会走失败分支。

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

1. 检查镜像已经 `docker load` 到节点，检查第 1 节列出的节点文件都存在；
2. 用新镜像一次性运行迁移（`node packages/db/scripts/migrate.ts`，只读 `staging-migrator.env`，挂载数据库 CA），迁移失败直接停下，正在运行的进程不受影响；迁移脚本出错时只打印错误类型和去掉口令的消息；
3. `docker compose up -d --force-recreate --wait` 重建全部五个进程并等五个健康检查都通过（上限 240 秒）：api / stream / admin 要求本进程 `/healthz` 返回 2xx，五个进程都要求容器已连续运行 30 秒，并且在本次部署被标记为稳定（`/tmp/couli-settled`）之前**只启动过一次**。`boot.mjs` 每次进程启动往容器内 `/tmp/couli-starts` 追加一行：这个文件在容器的可写层里，自动重启后还在，重建容器后清空。所以本次部署中任何一个进程（包括没有端口的 worker 与 payout）哪怕只崩溃、重启过一次，健康检查就一直不通过，这一步失败并回退。健康检查自己不写稳定标记，崩溃重启过的进程以后一直不健康；但 `up --wait` 对已经见过健康的服务不一定再看一遍，所以从任一服务首次健康后到 `up --wait` 返回这一整段里发生的崩溃重启，这一步可能发现不了，要靠第 4 步核对；
4. 五个都健康后，再用 `docker inspect` 核对五个容器的 RestartCount 都是 0；通过后才往五个容器里写 `/tmp/couli-settled`（以后节点重启等情况下的自动重启只需重新等 30 秒，不会一直不健康），然后把新标签写入 `/var/lib/couli/staging-api.tag`，并把这次用的 `compose.yaml` 存一份为 `/var/lib/couli/compose.<标签>.yaml`；
5. 删除更早的 `couli-api` 镜像和对应的 compose 副本，只保留本次和上一次成功的标签（回退要用），避免写满与数据库共用的 20G 系统盘。本次标签与上一次成功的标签相同（重复部署同一版本）时不删任何镜像，之前留下的回退镜像保留。

脚本不打印任何环境文件的内容，也不开启命令跟踪。

健康判定的边界：worker 与 payout 没有端口，健康检查只能看到「进程只启动过一次、连续活了 30 秒」，看不到队列是否已经开始消费；进程如果卡在等数据库连接而没有退出，这一步也会通过，部署后要看日志确认。第 4 步核对 RestartCount 不为 0（崩溃发生在任一服务首次健康后到 `up --wait` 返回这一段里）时，脚本不记录标签、以非零退出并提示手动回退命令 `deploy.sh <上一个成功标签>`，不会自动回退（自动回退只挂在第 3 步的切换结果上），这时要按第 4 节手动回退。脚本结束之后才发生的崩溃要靠看状态发现。

## 4. 回退

- **自动回退**：第 3 步健康检查不通过时，脚本把五个进程切回状态文件里记录的上一个成功标签，再等一次健康检查，然后以非零退出。回退用该标签成功部署时存下的 `/var/lib/couli/compose.<标签>.yaml`（旧镜像不一定配得上新版 compose）；没有这份副本（例如该标签是本版本脚本之前部署的）时用当前的 `compose.yaml` 并打印提示。首次部署没有上一个标签，脚本只报错退出，容器保留用于排查。
- **手动回退**：直接用旧标签再部署一次，`deploy.sh <旧标签>`。该标签成功部署时存下的 `/var/lib/couli/compose.<旧标签>.yaml` 还在时就用它（与自动回退一致）；不在时用脚本旁当前的 `compose.yaml`，并打印一行说明。
- 迁移只向前执行，回退不会撤销已经执行的迁移；新迁移必须与上一个版本的代码兼容（先加后删）。

## 5. 看状态与日志

```sh
cd /opt/couli/staging
docker compose -f compose.yaml --env-file /etc/couli/staging.env ps
docker compose -f compose.yaml --env-file /etc/couli/staging.env logs --since 30m api
cat /var/lib/couli/staging-api.tag
```

`docker compose` 需要 `COULI_API_TAG` 才能解析镜像名，手工执行前先 `export COULI_API_TAG=$(cat /var/lib/couli/staging-api.tag)`。日志用 json-file 驱动，每个容器最多保留 5 个 20 MB 的文件。
