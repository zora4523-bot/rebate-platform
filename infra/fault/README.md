# 本地故障注入（QA-05a）

共用入口是 `fault.ts` 的 `buildMappings` 和 `runCli`，B1-14、QA-06 可引用。
仅在本地隔离环境使用，独立 Compose 项目 `couli-fault`，端口只发布到
`127.0.0.1:18089`，容器网络禁止外网，不开启代理或录制。无需新增 npm 依赖。

## 镜像摘要尚待补齐

镜像锁定为 `wiremock/wiremock:3.13.1@sha256:d61e7720f89483fdef5366843b58d1dfd06bcce5828179c9f2f54de5c28354b0`（多架构清单摘要，2026-10-06 由编排者在沙箱外用 `docker buildx imagetools inspect wiremock/wiremock:3.13.1` 核实）。升级版本时重新核实并替换字面量摘要，不用猜测值。

执行下面的操作。Docker 命令由编排者在沙箱外执行；本轮验收中的 Node
命令必须在隔离验证容器执行，不在宿主运行新写的代码，容器内按下文设置服务名地址。

## 启停与装载

从仓库根目录执行，使用仓库规定的 Node 24：

```sh
docker compose -f infra/fault/compose.yaml up -d
curl --fail http://127.0.0.1:18089/__admin/mappings
node infra/fault/cli.ts load
node infra/fault/cli.ts switch bailian timeout
node infra/fault/cli.ts switch bailian normal
docker compose -f infra/fault/compose.yaml down
```

首次启动需等待管理接口可用，再 `load`。容器不保存桩或场景状态，重建后必须重新
装载。`load` 不带参数装载所有目标，也可执行 `load union.jd` 或
`load bailian union.jd`；使用固定桩 ID 覆盖已有桩，不清空其他目标或其他工具的桩。
要复位全部状态，执行 `down`、`up -d` 并重新 `load`。

`FAULT_WIREMOCK_URL` 默认 `http://127.0.0.1:18089`。允许的主机仅为
`127.0.0.1`、`localhost`、`[::1]` 和 `wiremock`，仅允许 HTTP 根地址；
拒绝凭据、路径、查询串、片段及其他主机。容器内调用方须接入同一隔离网络，使用
`FAULT_WIREMOCK_URL=http://wiremock:8080`。CLI 不发送鉴权信息、不跟随重定向，
管理请求 5 秒超时，不自动重试。退出码：0 成功，1 管理请求失败，2 参数错误（不发请求）。

## 目标与场景

| 目标 | 被测适配器的 base URL（宿主） | 支持场景 |
| --- | --- | --- |
| `bailian` | `http://127.0.0.1:18089/bailian/compatible-mode/v1` | `normal`、`delay`、`timeout`、`rate_limited`、`server_error`、`connection_reset` |
| `union.taobao` | `http://127.0.0.1:18089/union/taobao` | `timeout`、`rate_limited`、`server_error`、`connection_reset` |
| `union.jd` | `http://127.0.0.1:18089/union/jd` | 同上 |
| `union.pdd` | `http://127.0.0.1:18089/union/pdd` | 同上 |

`normal` 立即返回 200，`delay` 延迟 1000 ms 返回 200；仅百炼支持这两项，
返回公开 OpenAI 兼容的合成 `chat.completion`，只匹配 POST `/chat/completions`，
不模拟模型推理、工具调用或 SSE。`created: 0` 和零 token 用量是固定夹具字段。
`timeout` 延迟 15000 ms 后返回无响应体的 504，超过在线 3 秒与离线 10 秒超时，
被测客户端仍须自行配置超时。`rate_limited` 立即返回无响应体的 429，带
`Retry-After: 1`；`server_error` 立即返回无响应体的 503；`connection_reset`
使用 WireMock 的 `CONNECTION_RESET_BY_PEER`，具体客户端异常以隔离环境实测为准。

联盟桩匹配各自 `/union/<platform>/` 下的路径，只提供传输层故障，不伪造平台
成功或错误报文；初始 `Started` 状态不匹配无场景头的请求（WireMock 返回未匹配响应）。
百炼初始状态等同 `normal`。后续真实联盟录制与回放由 B1-04c 提供。

`switch <target> <scenario>` 只切换该目标的全局状态，先 `load` 再切换。
单次请求可以带 `X-Scenario` 头选择支持的场景，其优先级高于全局状态且不改变
全局状态。头值区分大小写；不支持的值不会命中头部桩，仍按当前全局状态处理。
并行用例应使用请求头或独立容器，避免互相切换全局状态。

```sh
curl --fail -X POST \
  -H 'Content-Type: application/json' -H 'X-Scenario: normal' \
  -d '{"model":"couli-synthetic","messages":[]}' \
  http://127.0.0.1:18089/bailian/compatible-mode/v1/chat/completions
```

编排者应在隔离容器运行冻结规则测试 `test/spec/fault/**`，并实际核对镜像拉取、
重复装载、目标切换、头覆盖、超时和连接重置；本任务的 Codex 沙箱只做静态检查。
