# contracts：接口契约（唯一来源）

接口、错误码、枚举的形状只在这里维护（D17，规划/11 §5.4）；服务端校验、四端客户端类型都由这里生成，生成物不手改。风险级 RV1，破坏兼容为 RV2；契约任务全局同时只有 1 个在途（规划/11 §1.1、§3.4）。

## 现在有什么

| 文件 | 内容 |
| --- | --- |
| `openapi.yaml` | OAS 3.1，v0.9：`GET /healthz` 加「登录 → 搜索 → 转链跳转」11 个接口（CT-02a）；其余接口随功能补 |
| `redocly.yaml` | lint 规则：`recommended-strict`（推荐规则集，警告一律按错误）；关掉的规则逐条写了原因 |
| `.redocly.lint-ignore.yaml` | 精确到位置的例外，逐条写原因；手工维护，不用 `--generate-ignore-file` 重新生成 |
| `error-codes.yaml` | 错误码：码值、HTTP 状态、含义、客户端动作、可重试、`data` 字段形状、来源条目（CT-01；码值只按 08 §13.11） |
| `enums/*.yaml` | 枚举：按主题分文件（平台、商品与转链、订单、资金、身份、消息与 Agent、后台权限点），04 §2 与 08 §13 的取值（CT-01） |

## 以后会放在这里的文件（规划/02 §16.2）

下面这些文件由对应任务创建，现在**不建空文件占位**：

| 文件 | 内容 | 由谁创建 |
| --- | --- | --- |
| `bridge.schema.json` | JSBridge 方法、参数、结果、权限级别 | 契约任务 |
| `agent-stream.schema.json` | SSE 事件与卡片 | 契约任务 |
| `home-schema.json` | 首页页面与组件 props | 契约任务 |
| `routes.json` | 页面路由名 → 原生页 / H5 URL | 契约任务 |
| `apps.json` | 外跳目标 App | 契约任务 |
| `design-tokens.json` | 颜色、字号、间距、圆角 | 契约任务 |

## 命令

| 用途 | 命令 |
| --- | --- |
| 检查契约 | `pnpm contracts:lint` |
| 重新生成 TS 类型（`packages/contracts-ts/src/{openapi,enums,error-codes}.gen.ts`） | `pnpm contracts:codegen` |
| 检查 + 生成物无漂移（`verify:fast` 里跑） | `pnpm contracts:check` |

改了 `openapi.yaml`、`enums/`、`error-codes.yaml` 必须在同一个 PR 里重新生成并提交生成物。

TODO(规划/11 §4.1): oasdiff 破坏兼容检查（`fail-on: ERR`，CI 下载官方二进制）与 Prism mock（prism-cli 要 Node ≥24.18，ADR-0001 §7） — blocked on GitHub remote

## 书写规则

通用约定见 `规划/04` §5（响应外壳 `{ code, msg, data, trace_id }`、蛇形命名、时间与分页格式、请求头、`x-auth`、`x-signed`）。另外：

1. 每个接口必须有 `operationId`（唯一、可作标识符）、`summary`、`tags`、`x-auth`、至少一个 `example`。测试会核对「契约里的 operationId」与「已注册路由」一一对应。
2. 金额字段以 `_fen` 结尾，`type: integer` + `format: int64`，不用字符串（ADR-0001 §4.2 第 3 项）；比例以 `_bp` 结尾，整数万分之一。ID 一律字符串。
3. `unevaluatedProperties` 旁必须写 `type: object`；`prefixItems` 必须配 `minItems`。否则应用启动即失败（ADR-0001 §4.2 第 15 项）。
4. 对象默认写 `additionalProperties: false`（或上一条的 `unevaluatedProperties: false`），并列出 `required`。
5. 只用 Swift / Kotlin / ArkTS / TS 四个生成器都支持的 3.1 写法（TECH-27）。固定取值用 `enum`，不用 `const`。
6. schema 对象里不放 `x-` 扩展字段：服务端与测试用 strict 模式的 `Ajv2020` 编译，未知关键字会报错。`x-auth` 等扩展只写在 operation 上。
7. 整数必须带 `format: int32` 或 `int64`（校验器为这两个格式注册了范围检查，超过 2^53−1 的 `int64` 会被拒绝）。
8. `/v1` 内只允许新增可选字段、新增接口、新增枚举值；删除、改名、改类型、改语义都算破坏兼容（规划/04 §5「兼容」）。
9. 关掉任何 lint 规则都要在 `redocly.yaml` 或 `.redocly.lint-ignore.yaml` 里写原因；这两个文件的改动按契约评审。
10. `/v1` 接口的 operation 上必须写 `x-auth`、`x-signed`、`x-idempotent`（04 §6 标 I）与 `x-error-codes`（本接口特有的业务码，公共码见 `info.description`）。`x-signed: true` 时三个签名头参数都要列，`x-idempotent: true` 时要列 `Idempotency-Key`；`security` 与 `x-auth` 对应（none → `[]`，optional → `[{}, bearerAuth]`，其余 → `bearerAuth`）。
11. 与 `enums/` 同名同义的枚举（平台、场景、排序、rebate_basis 等）取值必须与 `enums/` 完全一致，对应关系登记在 `packages/contracts-ts/scripts/conformance.ts` 的 `ENUM_BINDINGS`；新增枚举字段时一并登记。
12. 第 4 条的两处例外：错误外壳的 `data`（各码字段见 `error-codes.yaml`）和 `/v1/config` 里形状未定的块（`FreeForm`），由用到它们的任务补形状。

第 10、11 条与金额字段为 int64 由 `pnpm contracts:check` 里的一致性检查（`conformance.ts`）执行。

## 枚举与错误码的写法

1. 枚举文件只有顶层键 `enums`；每个枚举 `<snake_case 名>: {source, description?, values}`，`values` 是「编码: 说明」。编码就是线上取值，不另起别名；说明不是用户文案（文案只在 08 BR-TEXT 与 `/v1/dict`）。
2. 枚举名全仓唯一。P1、预埋、停用的值在说明里写明；停用且「编码保留不复用」的值不列入（如 `SELF_REBATE`、`NEGATIVE_BALANCE_OTHER`）。04 只写了增量、没给全集的（`users.status` 只写了新增 `deleting`、`deleted`，`users.deleted_reason` 只写了 `merged`，同意渠道 `consent_channel` 只写了部分取值）暂不建枚举，由用到它们的任务补全取值后再加。
3. `error-codes.yaml` 按码值升序；新码先登记 08 §13.11，再改本文件；废弃码保留并标 `deprecated: true`。字段含义见文件头注释。
4. 两类文件都用仓库的严格 YAML 子集（`tools/lib/yaml-lite.ts`）解析：不用锚点、多行折叠和流式映射；含「: 」的值加引号。
5. `openapi.yaml` 里的枚举字段与这里的取值保持一致，由 CT-02 起的契约任务逐个对齐。
