# WireMock 本地压测桩（QA-06b）

供 QA-06a 把 API 的上游指向本地假服务。遵守 09 README §0.2 硬规则 5：
压测只打本地，不访问真实联盟或模型。容器不启用代理和录制，网络设为内部网络，
管理端口只发布到 `127.0.0.1:18090`，与 QA-05a 的 `18089` 分离。
镜像版本与摘要直接沿用 QA-05a 已核实的值，不需要新增 npm 依赖。

## 生成、启动与导入

以下生成命令由编排者在隔离验证容器内、以仓库为当前目录执行，使用 Node 24。
生成过程只读录制文件并输出 JSON，不联网、不启动服务、不读取环境配置。

```sh
mkdir -p .tmp/load-wiremock
node infra/load/wiremock/render.ts fixtures/union-recordings \
  '{"delayMs":20,"faultPercent":10,"faultKind":"server_error"}' \
  > .tmp/load-wiremock/import.json
```

生成成功后，由编排者在沙箱外启动本地服务并导入生成的文件：

```sh
docker compose -f infra/load/wiremock/compose.yaml up -d
curl --fail http://127.0.0.1:18090/__admin/mappings
curl --fail -X POST -H 'Content-Type: application/json' \
  --data-binary @.tmp/load-wiremock/import.json \
  http://127.0.0.1:18090/__admin/mappings/import
```

须等管理接口可用后再导入。每次改变参数、录制集合或开始独立测量前，先重建容器，
再导入新的文件；这样不会残留旧映射和场景计数。固定映射 ID 使同一配置可重复导入，
但单独导入不会删除旧配置多出来的映射，也不保证重置场景状态。

```sh
docker compose -f infra/load/wiremock/compose.yaml down
docker compose -f infra/load/wiremock/compose.yaml up -d
```

测量结束执行同一 `down` 命令。容器不挂持久卷。这里提供桩与离线生成入口，
API 的端点注入、k6 加压和测量报告由 QA-06a 负责。

## 联盟回放

`readUnionRecordings(root)` 按 `fixtures/union-recordings/<platform>/<scenario>/`
读取 `recording.json` 和 `provenance.json`。只支持 `taobao`、`jd`、`pdd`；
缺根目录、半份录制、非法 JSON、符号链接、非法来源或非法信封都会报错。
两份文件原样返回，生成映射时校验 B1-04c 格式。重复的平台与场景组合拒绝导入。
没有录制的组合不会生成联盟桩，也不提供万能成功应答。

API 使用 replay 模式，base URL 为 `http://127.0.0.1:18090/union/<platform>`。
请求路径与查询串、GET/POST 方法、`X-Scenario` 头以及录制请求体必须精确一致；
没有录制请求体时只匹配空 HTTP 实体。录制应答的状态、响应头和正文保持原值。
查询或转链能否成功取决于提供的录制，公共 `synthetic-smoke` 只是传输层合成样例，
不代表已接通真实平台。真实录制只留在私有位置，不能写进本仓库或当作合成素材。

## 百炼 SSE

base URL 为 `http://127.0.0.1:18090/bailian/compatible-mode/v1`，
只接 POST `/chat/completions`，不匹配任何鉴权头取值。
首轮输出分成两片的工具参数，以 `tool_calls` 结束；请求含网关生成的
`"tool_call_id"` 键时视为带工具结果的后续轮，返回两段文本并以 `stop` 结束。
两种应答均有独立 usage 片和 `data: [DONE]`。内容、元数据与 token 数均为合成值，
不能当作真实模型计量。该桩约定使用网关的 JSON 请求形状，不是通用模型服务。

这是含多个 SSE 帧的固定应答正文；`delayMs` 控制整份应答的延迟，
不模拟模型逐 token 的到达间隔或网络分片时序。

## 参数与故障计数

`buildLoadImport(recordings, options)` 返回 `/__admin/mappings/import` 的请求体。
参数只从函数入参（命令行入口中的 JSON）读取，不读取环境变量。

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `delayMs` | `0` | 0～60000 的整数，所有正常回放应答固定延迟毫秒数 |
| `faultPercent` | `0` | 0～100 的整数，每组串行请求的 100 次循环中故障槽数量 |
| `faultKind` | `server_error` | `server_error` 为 503，`rate_limited` 为 429，`connection_reset` 为连接重置 |
| `toolCall` | `search_products` 与合成查询参数 | `{ name, arguments }`，arguments 必须是 JSON 对象 |

故障槽没有响应体；429 附 `Retry-After: 1`。故障槽不叠加 `delayMs`。
每个平台与场景、百炼首轮与后续轮分别计数。非零比例用独立 WireMock 场景的
100 个状态构成循环，故障尽量均匀分布；0% 只用正常映射。正常基准映射始终保留，
循环状态映射优先级更高，100% 时每个可达状态都是故障。

比例指额外注入的故障；如果录制本身返回错误，不能把总错误率视为 `faultPercent`。
WireMock 场景状态是组内共享状态，高并发请求可能同时匹配同一个状态，
因此每 100 次精确计数只适用于串行请求。QA-06a 的并发压测必须记录实际故障比例，
不能直接把配置百分比当实测值。

本轮不在宿主运行生成器或规则测试。编排者需在隔离容器执行冻结测试
`test/spec/load/wiremock/**`，并在本地隔离栈核对导入、SSE 消费、重置与并发行为。
