# apps/api（@couli/api）

NestJS 12 模块化单体 + Fastify 适配器，五个进程入口：`api` / `stream` / `admin` / `worker` / `payout`（`src/main.<入口>.ts`，ADR-0001 §2）。骨架期只有 `platform`、`health` 两个模块；`stream`、`admin`、`worker`、`payout` 目前是只会启动的空入口。

## 依据（只写指针，不复述）

| 要查什么 | 看哪里 |
| --- | --- |
| 模块边界、每张表的唯一写者、模块依赖 | 规划/02 §4.1 |
| 模块内部分层 | 规划/02 §4.2 |
| 数据库与编码规约（必备字段、类型、唯一性、外键、分页、日志脱敏） | 规划/02 §19 |
| 数据库设计规则（主键、金额 JSON 表示、分区、角色、测试库、时钟、连接池、请求校验） | ADR-0001 §4 |
| 一致性与并发的固定做法 | 规划/02 §18 |
| 接口形状 | `contracts/openapi.yaml`；表结构 `db/schema.sql` |

## 模块分层（`src/modules/<模块>/`）

- `domain/` 纯 TS，不依赖 Nest 和数据访问；金额只调 `@couli/money`，状态迁移只调生成的 `transition()`。
- `application/` 用例服务；`infra/` 仓储、任务入队（只经 `JobQueue`）、外部适配器；`jobs/` 任务处理器。
- `http/public/` 是 `/v1` 控制器，`http/admin/` 是 `/admin/v1` 控制器：只做鉴权、取参、调用用例。
- `index.ts` 是模块唯一的对外出口：跨模块只能从对方的 `index.ts` 导入，不得直接读写对方的表。
- 资金、订单模块必须有自己的 `AGENTS.md` + 一行 `@AGENTS.md` 的 `CLAUDE.md`。

## 硬规则

1. **单一写者**：每张表（或一组列）只有一个模块能写；只有 `ledger` 改余额。
2. **时间只读注入的 `Clock`**（`@Inject(CLOCK)`）。`new Date()`、`Date.now()` 只允许出现在 `src/modules/platform/clock/`；测试用 `FixedClock`。`CLOCK_NOW` 在 prod 设置即拒绝启动；不支持用请求头改时钟（ADR-0001 §4.2 第 10 项）。
3. **日志只用 pino**：注入 `ROOT_LOGGER` 或其子 logger；不用 `console`。只打平铺字段，不序列化整个请求或用户对象；新增敏感字段名时同步 `platform/logging` 的脱敏清单。
4. **只用 Fastify**：不引入 Express 适配器或 Express 中间件；HTTP 测试只用 Fastify `inject`，不引入别的 HTTP 测试库。
5. **校验来自契约**：不写 class-validator DTO，不用 `@nestjs/swagger`；控制器的响应类型取自 `@couli/contracts-ts`。新增或修改接口先改 `contracts/openapi.yaml`（另开契约任务），测试会核对 operationId 与已注册路由一一对应。
6. **配置只经 `loadConfig`**：业务代码不直接读 `process.env`；新增环境变量加进 `platform/config` 的 schema 并补测试。
7. 数据访问只用 Kysely + pg，队列只经 `JobQueue`（都随 B1-01 加入，现在还没有）；不引入第二种数据访问方式。
8. 本包可以用装饰器与参数属性（Nest 需要）；相对导入一律带 `.ts` 后缀；`import type` 用于只作类型的导入。

## 测试

- 单元测试 `src/**/*.test.ts`：不连库、不 `listen`、不联网、不引用 testcontainers。HTTP 用 `createHttpApp()` + `app.init()` + `app.inject()`。
- 集成测试 `*.int.test.ts` 只在沙箱外跑，数据库入口读 `TEST_PG_ADMIN_URL`（ADR-0001 §4.2 第 9 项）。
- 响应必须过契约校验（`src/contract.test.ts` 的做法）；测试标题带 `[AC-xxx]`。
- 不写 `.skip`、`.only`、`retry`；每个测试有断言。实现者只写单元测试，不写自己的规则测试。

## 命令

| 用途 | 命令 |
| --- | --- |
| 单元测试 | `pnpm --filter @couli/api test` |
| 类型检查与构建 | `pnpm exec tsc -b apps/api apps/api/scripts` |
| 五个入口冒烟（先构建） | `pnpm --filter @couli/api run smoke:entries` |
| 本机启动 | `APP_ENV=local node apps/api/dist/main.api.js` |
