# contracts：接口契约（唯一来源）

接口、错误码、枚举的形状只在这里维护（D17，规划/11 §5.4）；服务端校验、四端客户端类型都由这里生成，生成物不手改。风险级 RV1，破坏兼容为 RV2；契约任务全局同时只有 1 个在途（规划/11 §1.1、§3.4）。

## 现在有什么

| 文件 | 内容 |
| --- | --- |
| `openapi.yaml` | OAS 3.1，v0.9：`GET /healthz` 加「登录 → 搜索 → 转链跳转」11 个接口（CT-02a）、幂等键作废接口与 `x-step-up` 扩展（CT-16a）、设备与第三方登录（CT-15b）、`x-min-version-gate` 与 `x-session-scopes`（CT-17a）；其余接口随功能补 |
| `redocly.yaml` | lint 规则：`recommended-strict`（推荐规则集，警告一律按错误）；关掉的规则逐条写了原因 |
| `.redocly.lint-ignore.yaml` | 精确到位置的例外，逐条写原因；手工维护，不用 `--generate-ignore-file` 重新生成 |
| `error-codes.yaml` | 错误码：码值、HTTP 状态（个别码另在 `http_also` 列出额外状态，如 20001 的 413 / 415）、含义、客户端动作、可重试、`data` 字段形状、来源条目（CT-01；码值只按 08 §13.11） |
| `enums/*.yaml` | 枚举：按主题分文件（平台、商品与转链、订单、资金、身份、消息与 Agent、后台权限点），04 §2 与 08 §13 的取值（CT-01） |
| `bridge.schema.json` | JSBridge（CT-03）：信封、权限级别、桥错误码 90001–90500、`signed_paths` 白名单（MVP 只有 `POST /v1/orders/claims`，TECH-30）、事件，以及 04 §9 每个方法的 `level`、`model`、`timeout_ms`、`since`（按端）和 params / result 的 JSON Schema |
| `routes.json` | 路由表（CT-03）：路由名 → `native` 或 `h5` + `h5_path`，`auth`、按端 `since`（TECH-07，null 表示该端尚未提供）、params 的 JSON Schema；跳转一律 `{route, params}`，外链用 `ExternalPage`（TECH-04） |
| `apps.json` | 外跳目标 App 骨架（CT-03）：`ext.openApp` 与已装检测只认这里的键；取值都是 09 的候选（`status: candidate`），对应 CAP 实测后改 `verified` |
| `texts.default.json` | 客户端包内默认文案（CT-16e）：BR-TEXT-12 字典机制的兜底，接口没下发或字典没有该键时用。键与文案照 08 原文转写，一字不改：BR-TEXT-14 表 A（`error.<code>`）、表 B（`error.<code>.<reason>`）、表 C、表 D，BR-TEXT-01 收益看板（`earnings.*`），BR-TEXT-03（`order.price_compare.hint`），BR-TEXT-22 固定话术。`texts` 是默认文案，`{name}` 占位符照原样保留；`fallbacks` 是 08 给出的变量缺失时的写法（表 A「包内默认（变量缺失时）」等）。**表 D（`privacy.*`、`perm.*`）是代理起草的占位措辞，待法务定稿（规划/06 Q-F14），不得用于提审与公开版本**；08 只写了要点、没写文案的键（如 `privacy.first_launch.*`）不建。后台文案不进这里。`pnpm contracts:check` 校验键名、值非空、键按字母序且不重复，并核对 `error-codes.yaml` 每个未废弃、非 P1 的码都有 `error.<code>`（表 A 标「—」静默处理的 10002、10402、30505、44003 除外，登记在 `packages/contracts-ts/scripts/texts.ts`） |

## 以后会放在这里的文件（规划/02 §16.2）

下面这些文件由对应任务创建，现在**不建空文件占位**：

| 文件 | 内容 | 由谁创建 |
| --- | --- | --- |
| `agent-stream.schema.json` | SSE 事件与卡片 | 契约任务 |
| `home-schema.json` | 首页页面与组件 props | 契约任务 |
| `design-tokens.json` | 颜色、字号、间距、圆角 | 契约任务 |

## 命令

| 用途 | 命令 |
| --- | --- |
| 检查契约 | `pnpm contracts:lint` |
| 重新生成 TS 类型（`packages/contracts-ts/src/{openapi,enums,error-codes,bridge}.gen.ts`） | `pnpm contracts:codegen` |
| 检查 + 生成物无漂移（`verify:fast` 里跑） | `pnpm contracts:check` |

改了 `openapi.yaml`、`enums/`、`error-codes.yaml`、`bridge.schema.json`、`routes.json`、`apps.json` 必须在同一个 PR 里重新生成并提交生成物。

CI 的 `contracts-check` 用 oasdiff（官方二进制，`--fail-on ERR`）对比基线契约查破坏兼容；基线里仍标 `x-implementation: planned` 的接口不参与比较（`tools/ci/oasdiff-base.ts`：没有路由也没有调用方，改它的请求或响应不影响任何客户端），去掉标记之后的改动照常比较。

TODO(规划/11 §4.1): Prism mock（prism-cli 要 Node ≥24.18，ADR-0001 §7） — blocked on GitHub remote

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
10. `/v1` 接口的 operation 上必须写 `x-auth`、`x-signed`、`x-idempotent`（04 §6 标 I）与 `x-error-codes`（本接口特有的业务码，公共码见 `info.description`）。`x-signed: true` 时三个签名头参数都要列，`x-idempotent: true` 时要列 `Idempotency-Key`；`security` 与 `x-auth` 对应（none → `[]`，optional → `[{}, bearerAuth]`，其余 → `bearerAuth`）。每个 `/v1` 接口声明 `429`（`TooManyRequests`，带必填 `Retry-After`）。还没有路由的接口标 `x-implementation: planned`；`apps/api/src/contract.test.ts` 要求带标记的接口没有路由、不带标记的恰好有一个，实现路由的任务同时去掉标记。
11. 与 `enums/` 同名同义的枚举（平台、场景、排序、rebate_basis 等）取值必须与 `enums/` 完全一致，对应关系登记在 `packages/contracts-ts/scripts/conformance.ts` 的 `ENUM_BINDINGS`；只允许子集的字段（如 parse、convert 的 `scene`，客户端不能自选归因场景）登记在 `ENUM_SUBSETS`。新增枚举字段时一并登记。
12. 第 4 条的两处例外：错误外壳的 `data`（各码字段见 `error-codes.yaml`）和 `/v1/config` 里形状未定的块（`FreeForm`），由用到它们的任务补形状。

13. 需要二次验证的操作在 operation 上写 `x-step-up: <step_up_action>`（04 §5 step-up 行；名称由契约自定，规划侧补登）。只有 04 §5 那四个接口能带，取值按该行的对应关系（`conformance.ts` 的 `STEP_UP_OPERATIONS`）；带它的接口必须 `x-idempotent: true`、列 `components/parameters/StepUpToken` 参数（`X-Step-Up-Token` 请求头，`required: false`、字符串 1–2048 字符：缺少、过期或 action 不符是业务码 10003，写成必填会被请求校验先拦成 20001）、`x-error-codes` 含 10003 与 20903；不带它的接口不列这个参数，也不列 20903。只对部分请求生效时把条件写在 operation 说明里（`POST /v1/me/phone` 只在更换时要求，首次绑定不要求）。这个参数组件由第一个挂 x-step-up 的任务（CT-15j / CT-16c）按上面的形状新建（现在建会成为未使用组件，lint 不过）。

14. 每个 `/v1` 写接口（POST、PUT、PATCH、DELETE）标 `x-min-version-gate`：`true`（受最低支持版本约束）、`false`、`conditional`（按请求体字段豁免，条件写在 operation 说明里）；GET 不标。取值只照规划/08 BR-ID-01 细则「最低支持版本的接口层拦截」的接口表，`conformance.ts` 的 `GATE_EXCEPTIONS` 是它的副本（不一致以 08 为准、改副本）；表里「不判定」的接口写 `false` 并在说明写「不判定：非三端请求」。`true` 与 `conditional` 的接口 `x-error-codes` 含 10405。
15. BR-ID-01 细则「受限会话」表里的接口标 `x-session-scopes: [full, deletion_only]`（`conformance.ts` 的 `DELETION_ONLY_SCOPE` 是副本），只对部分请求体接受的在说明里写条件；其余接口不标（等于 `[full]`）。带令牌调用不接受其作用域的接口返回 10405，作为公共码写在 `info.description`，不逐接口列；受限登录（四个登录接口）另列 10405（`data.reason=no_account`）。以后声明的接口都按这两条标注。

第 10、11、13、14、15 条与金额字段为 int64 由 `pnpm contracts:check` 里的一致性检查（`conformance.ts`）执行。

## 枚举与错误码的写法

1. 枚举文件只有顶层键 `enums`；每个枚举 `<snake_case 名>: {source, description?, values}`，`values` 是「编码: 说明」。编码就是线上取值，不另起别名；说明不是用户文案（文案只在 08 BR-TEXT 与 `/v1/dict`）。
2. 枚举名全仓唯一。P1、预埋、停用的值在说明里写明；停用且「编码保留不复用」的值不列入（如 `SELF_REBATE`、`NEGATIVE_BALANCE_OTHER`）。04 只写了增量、没给全集的（`users.status` 只写了新增 `deleting`、`deleted`，`users.deleted_reason` 只写了 `merged`，同意渠道 `consent_channel` 只写了部分取值）暂不建枚举，由用到它们的任务补全取值后再加。
3. `error-codes.yaml` 按码值升序；新码先登记 08 §13.11，再改本文件；废弃码保留并标 `deprecated: true`。字段含义见文件头注释。
4. 两类文件都用仓库的严格 YAML 子集（`tools/lib/yaml-lite.ts`）解析：不用锚点、多行折叠和流式映射；含「: 」的值加引号。
5. `openapi.yaml` 里的枚举字段与这里的取值保持一致，由 CT-02 起的契约任务逐个对齐。

## 桥、路由与外跳表

1. 三个 JSON 文件由 `packages/contracts-ts/scripts/bridge.ts` 校验并生成 `src/bridge.gen.ts`（经 `index.ts` 以 `bridge` 命名空间导出）：方法名属于 04 §9 的命名空间；`sync` 方法 `timeout_ms` 为 null；params / result 都是 `additionalProperties: false` 的对象；`$defs` 里的平台、绑定状态与 `enums/` 一致，`AppTarget` 与 `apps.json` 的键一致；`signed_paths` 中已在 `openapi.yaml` 声明的接口必须 `x-signed`；iOS 查询 scheme 合计不超过 20 个；路由参数里的 `platform` 与方法里的 `realname_status`、`installed`、`channel` 取值与 `enums/` 一致。`nav.open` 的参数类型就是 `RouteTarget`。`debug_only` 的路由只在 debug / staging 包里能打开（TECH-11）。自由形状的对象写 `additionalProperties: true`，否则生成类型会成为空对象。
2. `timeout_ms: null` 的异步方法要等用户操作（登录、授权、分享等），不设超时。
3. 新增路由或方法时写清按端 `since`；尚未在某端发布的写 null。
4. 方法对象只允许 `level`、`model`、`timeout_ms`、`phase`、`since`、`note`、`gesture_required`、`whitelist_90403`、`share_page_paths`、`params`、`result` 这些键。`gesture_required`（boolean）只写在 L0 / L1 方法上，表示仍要求最近 1 秒内有用户点击（判定同 L2，无手势 90404，如 `clipboard.write`）；生成物 `bridgeMethods` 里的同名字段是实际值（L2 一律 true）。`whitelist_90403`（非空字符串）说明方法自身的白名单拒绝（03 §5.3），要求 `errors` 里有 90403；生成物里是 boolean。`share_page_paths` 只出现在 `share.open`、且必填：恰好 `product_share`、`invite_landing`、`download_guide` 三项（可另带 `$comment`），每项 `page` 与 `path_pattern`（null 表示尚未定，否则是以 `^/` 开头、`$` 结尾的正则），生成为 `sharePagePaths` 供三端生成器取用（04 §9，BR-ATTR-29 细则）。`auth.getH5Token` 的 `scope` 与 `enums/` 的 `h5_token_scope` 一致。
