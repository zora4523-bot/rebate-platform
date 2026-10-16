# 本地 k6 压测（QA-06a）

入口为 `script.ts`，参数、请求素材和阈值为同目录 `config.json`，纯参数构造器为
`options.ts`。不安装 npm k6 包；`k6-runtime.d.ts` 只声明本入口使用的容器 API，
不是 k6 实现。压测及规则测试均由编排者在隔离容器内执行。

## 当前接入条件

- TODO(规划/11 §4.5): 将 `compose.yaml` 镜像行替换为 `grafana/k6:1.3.0@sha256:` 加已核实的 64 位摘要 — blocked on 编排者联网核实镜像多架构摘要；当前无摘要即拒绝启动，冻结镜像规则测试尚不能通过，环境变量不能替代最终入库的摘要。
- TODO(规划/11 §5.3): 核对 Agent 发消息及手动同步的最终请求、鉴权、成功响应并完成联调 — blocked on `contracts/openapi.yaml` 尚未定义这两个接口；路径来自 SPEC_REF 的规划/04 §6.5、§6.6，同步请求体必须由本地实现提供，当前不编造同步字段或平台报文。

本目录提供负载驱动，以上接入条件完成前不能宣称四条业务链已压测通过。搜索和转链
路径与请求字段来自当前 `contracts/openapi.yaml`；默认商品只是公开契约样例编号，
本地演示适配器须准备对应商品和授权状态。Agent 帧按 `contracts/agent-stream.schema.json`
约定检查 meta、递增 id 和 done，拒绝 error、重复 run 与未完成流，不代替完整 JSON Schema 验证。

## 负载与判定

基准来源是 `SPEC_REF=68b2959cf2b680f11f084706fdfcf215beb7fa80` 的规划/01 §7.3
公开首月：API 峰值 50 QPS、Agent 50 并发。规划没有请求占比，30/15/5 是可校准的
压测分配，非新增业务指标；未使用“设计余量”500 QPS / 300 流作为基准。

| 场景 | 基准 → 三倍 | 执行器 | P95 | HTTP 错误率 |
| --- | --- | --- | --- | --- |
| `search` | 30 → 90 次/秒 | ramping-arrival-rate | <1500 ms | <1% |
| `convert` | 15 → 45 次/秒 | ramping-arrival-rate | <1500 ms | <1% |
| `agent_sse` | 50 → 150 个 VU | ramping-vus | 首字节 <1000 ms | <1% |
| `sync` | 5 → 15 次/秒 | ramping-arrival-rate | <3000 ms | <1% |

四个场景同时从零开始，30 秒升至三倍、保持 2 分钟、30 秒降至零。
前三项 P95 来自规划/01 §7.1；同步 3000 ms 与错误率 1% 为本地验收初值。
同步衡量的是手动同步 HTTP 请求耗时，不是付款到入库耗时，也不证明后台队列已经排空。
同步请求素材须能触发有效工作，避免反复命中同一批任务的去重结果。

HTTP 阈值按 `scenario` 分开；额外要求 `checks rate==1` 和 `dropped_iterations count==0`，
所以鉴权失败、HTTP 200 但 `code != 0`、非 JSON、错误/截断 SSE、负载机不能维持
请求率都会使运行失败。业务检查采用零容忍，不能仅看 HTTP 错误率。
VU 上限与请求超时在配置中，默认请求类上限按三倍每秒请求数乘 10 秒超时预留。

SSE 每个 VU 串行等待一条流结束再发送下一条，不插入 sleep；各 VU 使用不同的设备与
会话，每条消息有独立 `client_msg_id`。`http_req_waiting` 仅是首字节代理指标，
提前返回响应头或心跳会使它早于首个业务事件。标准 `k6/http` 缓冲完整响应，本脚本
不声称测到了首个完整事件时间；严格事件延迟另看服务端 trace，长流也需关注负载机内存。

## 隔离与复用

遵守 **09 README §0.2** 硬规则 5：不压真实联盟接口，不连真实模型、短信或打款。
上游与故障只复用 `infra/fault`，本目录不创建 WireMock、不加载新桩。
参考 `infra/fault/README.md` 启动和装载、切换故障；联盟正常结果使用已有演示适配器，
QA-05a 的联盟桩只有传输故障，百炼正常桩也不是 Agent SSE 接口，不能拿 WireMock
的成功响应代替应用端四条链路的验收。

编排者提供仅接入 `couli-fault_fault` 内部网络的本地测试网关容器；网关在自身回环
3000、3001、3002 端口分别代理测试 API、stream、admin，应用与上游同样禁止外网出口。
Compose 使用 `network_mode: container:...` 共享该网关网络命名空间，回环地址因此指向
测试入口；不是 Docker 宿主机。不要使用 host 网络或接入生产环境的容器。

脚本与环境覆盖只接受 `127.0.0.1`、`localhost`、`[::1]`、`wiremock` 的 HTTP(S)
根地址；拒绝用户密码、路径、查询、片段、其他主机。每次请求禁止重定向，返回的跳转
链接不会被打开。此校验限制直接请求；应用的间接上游访问仍靠内部网络隔离和演示适配器约束。
Compose 关闭 k6 使用情况上报与 Web dashboard。

## 夹具和环境变量

夹具由编排者在隔离环境准备，放工作区被忽略的 `.tmp/qa-06a/fixtures.json`，
通过 `LOAD_FIXTURES_FILE` 的绝对路径只读挂载到 `/load/fixtures.json`；不能提交账号或令牌。
文件结构为 `users` 数组、`admin_token` 字符串、`sync_body` 对象。每个 user 必须有
`app_id`、`device_id`、`access_token`、`install_secret`、`session_id`，均来自本地种子，
所有设备和会话互异。`sync_body` 不为空，其字段以补齐后的同步契约为准。
默认需 1650 个条目（所有场景最大 VU 之和），按 k6 `idInTest - 1` 选取；不用
数组取模共享会话。修改 VU 参数后相应调整夹具数，设备/令牌必须匹配且在运行全程有效。

转链每次按契约 HMAC-SHA256 签名，动态生成时间戳、nonce、幂等键，不自动重试。
时间戳读取负载机时钟只用于 HTTP 验签，须与本地服务时钟同步；没有账务日期计算。
同步每次使用新幂等键；测试环境自行提供足量配额与权限，不修改生产限流规则。

| 变量 | 用途 |
| --- | --- |
| `LOAD_TARGET_CONTAINER` | 上述隔离网关容器名，必填 |
| `LOAD_FIXTURES_FILE` | 夹具的绝对路径，必填 |
| `LOAD_API_BASE_URL` | API 根地址，默认 `http://127.0.0.1:3000` |
| `LOAD_STREAM_BASE_URL` | stream 根地址，默认 `http://127.0.0.1:3001` |
| `LOAD_ADMIN_BASE_URL` | admin 根地址，默认 `http://127.0.0.1:3002` |
| `K6_IMAGE_DIGEST` | 仅补齐摘要前的启动阻断参数；最终验收须改成字面量摘要 |

## 编排者执行

先在允许联网的编排环境核实镜像，再把摘要写回 `compose.yaml`：

```sh
docker buildx imagetools inspect grafana/k6:1.3.0
```

隔离网络、演示上游、契约和本地夹具就绪后，从仓库根目录执行（环境变量由编排环境注入）：

```sh
docker compose -f infra/load/k6/compose.yaml config
docker compose -f infra/load/k6/compose.yaml run --rm k6
```

第二条命令执行全部四个场景，阈值失败时退出码非零；保留终端指标与退出码到编排产物目录，
不要把夹具或完整请求体写进报告。故障场景预期会触发性能门槛失败，与正常场景分开留证。
编排者还须在隔离验证容器运行冻结规则测试 `test/spec/load/k6/**`；本轮只执行静态检查。
