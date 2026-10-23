# Redis 运维手册（staging；prod 上线前照此核对）

> B1-01zzl（架构评估 R-04 / R-07，编排裁定 D10-183）。本文只记**现状与处置**，不定新的失效策略。Redis 失效时的策略见 R-04 影响评估记录（规划仓库 docs/changes/20261023-R04-Redis失效与防重放.md，方案待负责人选）。**规划/02 §14 的 Redis 行「写接口仍可用」与代码不符，以该记录 §2 为准**，直到负责人定了再回写。代码出处按 2026-10-23 主干。

## 1. 谁用 Redis

- 连 Redis：api、stream、admin、worker 四个进程，都从 `REDIS_URL` 读连接串（节点 `/etc/couli/staging.env`）。
- **不连 Redis：payout**（ADR-0001 §4.2 第 20 项）。
- 连接是延迟建立的：进程能在 Redis 不可达时启动，第一条命令才去连。连接和命令超时各 1 秒，失败不重试、不回落，由调用方决定怎么办。
- 现在的健康检查**不探 Redis**：Redis 挂了，容器照样显示 healthy（B1-01zzj 给 worker 补依赖探测）。

## 2. 节点上的 Redis 应有的设置

| 项 | 应为 | 依据 | 核对命令（在节点上，用 redis-cli 连内网地址） |
| --- | --- | --- | --- |
| 淘汰策略 | `maxmemory-policy noeviction` | ADR-0001 §4.2 第 17 项；ADR-0002 | `CONFIG GET maxmemory-policy` |
| 最大内存 | 显式设置（ADR-0002 写 2GB） | 同上 | `CONFIG GET maxmemory` |
| 内存告警 | 使用率 70% 告警 | ADR-0001 §4.2 第 17 项；告警规则见 B1-01zzh | `INFO memory` 的 `used_memory` / `maxmemory` |
| 口令与监听 | 设口令、只听内网 | ADR-0002 | `CONFIG GET bind`、`CONFIG GET protected-mode` |
| 持久化 | 开 AOF：`appendonly yes`、`appendfsync always`（先试，实测写延迟）、`no-appendfsync-on-rewrite no`（为 yes 时重写期间跳过 fsync，always 等于失效）；RDB 可以保留 | R-04 记录 §7；ADR-0002 §10 第 7 项（staging 核对后回写） | `CONFIG GET appendonly`、`CONFIG GET appendfsync`、`CONFIG GET no-appendfsync-on-rewrite`、`INFO persistence` |
| 危险命令 | 应用用的账号不能执行 FLUSHALL、FLUSHDB、DEBUG（改名为空或 ACL 禁用）；CONFIG 改随机名，只放节点 root 可读处 | R-04 记录 §7 | `ACL GETUSER <用户>` 或配置里的 `rename-command` |

**CONFIG 已改名的实例**（staging 已改）：上表和下文里的 `CONFIG GET` / `CONFIG SET` / `CONFIG REWRITE`，都要把 `CONFIG` 换成改名后的命令名，否则会报 `unknown command`。改名后的命令名存在节点上只有 root 可读的文件里，位置见私有仓库 `rebate-private/ops/pigsty/staging/README.md`。脚本里用 `N="$(cat <该文件>)"` 读出后执行 `redis-cli … "$N" GET <项>`。这个名字按口令对待，不要打印，也不要写进日志、文档或仓库。

**在已有 RDB 的实例上打开 AOF，不能直接改配置重启**——那样 Redis 会按空 AOF 起成空库，等于丢一次数据。要先在运行时 `CONFIG SET appendonly yes`，等 `INFO persistence` 显示重写完成（`aof_rewrite_in_progress:0`、`aof_last_bgrewrite_status:ok`），再把配置文件改成一致（Pigsty：`redis_aof_enabled: true`，只渲染不重启）。

为什么必须是 noeviction：下面这些键被静默淘汰时，安全或计费性质会变（不只是缓存未命中）——防重放 nonce、各类配额 / 频控计数、`refresh_grace`（ADR 点名）；按代码同样不能被淘汰的还有用户 step-up 令牌的已用标记、验证码、后台会话。内存满时 noeviction 让写入报错（调用方按第 3 节处理），而不是悄悄丢键。

staging 已于 2026-10-23 按本表设置并实测：AOF always，禁用 FLUSHALL / FLUSHDB / DEBUG，CONFIG 改随机名；正常重启与 `kill -9` 后带 TTL 的探针键都在。记录与 Pigsty 重渲染后的补回步骤见私有仓库 `rebate-private/ops/pigsty/staging/README.md`。prod 照此由负责人执行。

本地、CI 和测试机的一次性 Redis（256mb、noeviction、不落盘）只用于测试，不代表 staging 的设置。

## 3. Redis 不可达时（现状）

| 范围 | 现在的表现 |
| --- | --- |
| 带签名的接口（登录、refresh、提现、找回、转链、外跳、绑手机、实名等 22 个 `x-signed` 接口） | **全部返回 50001**：签名检查最后一步要在 Redis 登记 nonce，失败即拒（`risk/application/signature-check.ts`）。注意这与 规划/02 §14 Redis 行「写接口仍可用」不一致，已报编排（R-04） |
| 频控、设备注册与短信风控 | 返回 42901（Retry-After 1–5 秒），不放行 |
| 验证码、oauth 授权尝试、实名、step-up、找回计数、邀请计数 | 返回 50001 或 42901，业务不执行 |
| 后台需登录的接口 | 50001 |
| 风控状态缓存 | 改状态的写入回滚（50001）；读取改直读数据库 |
| 商品与转链缓存、搜索会话 | 当作未命中，直接请求联盟或数据库，变慢；翻页可能返回 50304 或不给下一页游标 |
| Agent 取消信号 | 改为每 2 秒读数据库，停下得晚一点 |
| payout、任务队列（pg-boss 在 PostgreSQL） | 不受影响 |

处置：
1. 先确认是 Redis 本身的问题（节点上 `redis-cli PING`），不要先重启应用进程——应用每条命令都会重新尝试连接，Redis 恢复后自动好转，不需要重启。
2. 恢复 Redis（重启服务或换实例）后，按第 4 节判断数据是否丢失。
3. 告警与上报按 B1-01zzh 的规则走；涉及资金的接口（提现）在这期间全部失败，不会产生半截的资金状态（提现申请在签名检查处就被拒，没有进业务）。

## 4. Redis 数据整体丢失后（重启无持久化、被清空或换新实例）

| 类别 | 后果 | 要不要处理 |
| --- | --- | --- |
| 防重放 nonce（`risk:nonce:…`，TTL 600 秒，时间窗 ±300 秒） | 丢失前约 300 秒内发出的签名请求，在丢失后约 300 秒内可以各重放一次（时钟偏差到 300 秒时最长 600 秒） | 丢失后 10 分钟内重点看提现、绑手机、实名等写请求的异常重复；业务侧的幂等键与唯一约束仍然有效 |
| 用户 step-up 令牌已用标记（`step_up:…`） | 已经用过的二次验证令牌，在它过期前（不超过 300 秒）可以再用一次 | 同上，关注 10 分钟内的提现与收款账号变更 |
| `refresh_grace`（30 秒宽限） | 正好在换发令牌的 30 秒内重试的客户端被当成令牌复用，整个会话被吊销，用户要重新登录 | 不用处理，影响是少量用户被登出 |
| 验证码、oauth 授权尝试、后台会话与登录票据、后台二次验证 | 全部失效：用户重新取码 / 重新授权，管理员全部掉线、重新登录 | 提前通知运营（后台会掉线） |
| 频控与配额计数（令牌桶、短信配额与预算、实名日次数、找回与邀请失败次数） | 清零：当天又可以用满一轮（实名可再调 3 次供应商，产生费用） | 关注当天的短信与实名费用 |
| 缓存（商品、转链、风控状态、搜索会话） | 全部未命中，变慢、联盟调用增多；后台「重置转链缓存」在 15 分钟内可能失效（推断） | 不用处理；如刚做过转链缓存重置，丢失后再做一次 |

## 5. 换空实例、清库或从备份恢复时

这几种情况都等于「数据丢失」，按同一套做（R-04 记录 §7）：换成空实例、执行了清库、从快照或备份恢复、用 `redis-check-aof --fix` 修过 AOF。

1. **先不让应用连上**：新实例或恢复后的实例先不接入（保持应用的 `REDIS_URL` 指向一个连不上的地址，或在节点防火墙上暂不放行应用到 Redis 的端口）。这期间签名接口按第 3 节返回 50001。
2. **从故障开始满 600 秒再放开**：600 秒是防重放 nonce 的 TTL（时间窗 ±300 秒的两倍）。等满之后，丢失前发出的签名请求都已过了时间窗，不能再被重放。
3. 新实例先按第 2 节设置（`maxmemory-policy`、`maxmemory`、AOF、危险命令），不合格不接。
4. 放开：恢复应用到 Redis 的连接（换实例时改节点 `/etc/couli/staging.env` 的 `REDIS_URL`，按 infra/staging/README.md 重新部署；`deploy.sh` 会先迁移、再切换全部进程；payout 不用动）。
5. 按第 4 节处理其余后果（会话、验证码、计数清零等）。
6. 在运维记录里写明时间、原因、丢失的窗口、放开的时刻。

代次识别（R-04 方案 A）上线后，第 1、2 步改为「放开应用前先删代次键」，届时按实现任务更新本节。

## 6. 停 Redis 演练（规划/02 §20）

按 R-04 记录 §4 的预期逐条核对：签名接口 50001、搜索 42901；浏览与 Agent 可用；access_token 到期的用户被登出；打款不受影响；Redis 恢复后不重启进程就自动好转。结果写进运维记录。

## 7. 待定（不在本文定）

- Redis 失效时签名接口的策略（方案 A / B / C）——R-04，待负责人选。
- 正常重启与异常退出后防重放、配额键的实测恢复情况——staging 核对后回写 ADR-0002 §10 第 7 项。
- Redis 告警规则（不可达、内存 70%、写入被拒）——B1-01zzh。
