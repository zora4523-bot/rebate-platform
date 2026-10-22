# apps/api/src/modules/payment（资金：收款基础设施）

支付单、渠道下单与调起参数、支付通知验签、查询、关单、后台原路退款、收款分录与 T+1 对账。开关默认关（`pay.enabled`、`pay.channel_enabled.<pay_channel>`）；生产不登记任何业务类型。HTTP 入口：`/v1/pay/orders…`（只限原生 App）、后台 `/admin/v1/pay-orders…`、通知入口 `/notify/pay/<pay_channel>`（公网、只凭验签）。

## 谁能改

- 风险级 RV2（资金，`ops/risk-map.yaml`）。主实现 Claude 子代理；规则测试作者 Codex（实现前先写、先红）；Codex 新只读会话资金评审，无未关闭的 S0 / S1 才合并（`ops/approvals.yaml` 第 19、27、36 条）。
- 实现者只写 `src/**/*.test.ts` 单元测试；规则测试在 `test/spec/payment/**`、`test/spec/db/pay/**`，实现任务不能改删。
- 不变量 SQL 在 `db/invariants/pay/`（保护路径，只能新增），由规则测试作者编写。

## 依据（只写指针，取值与公式只在 08）

| 要查什么 | 看哪里 |
| --- | --- |
| 模块职责、拥有的表、依赖 | 规划/02 §4.1 `payment` 行、§12.6 收款密钥 |
| 入口与开关、支付单与状态机、下单调起、结果判定、关单、退款、账务与对账、密钥与通知入口 | 08 BR-PAY-01～09（细则含默认值与通知应答表） |
| 接口、错误码、枚举 | `contracts/openapi.yaml`、`contracts/error-codes.yaml`、`contracts/enums/pay.yaml` |
| 状态机 | `specs/state-machines/pay-order.yaml`、`pay-refund.yaml`（生成 `@couli/domain` 的 `transition()`） |
| 通知入口 | `specs/pay-notify.md` |
| 表结构 | `db/schema.sql`（pay_orders、pay_notifications、pay_query_attempts、pay_refunds、pay_anomalies） |
| 渠道文档 | 私有库 `docs-mirror/wechat-pay/`、`docs-mirror/alipay/app-pay/`（文档已确认、未实测；规划/09 §5.7） |

## 硬规则

1. 不读写用户余额：不产生任何 USER_BALANCE 分录，不参与分佣、月结、提现；收款分录只经 ledger 的 `post()`，凭证类型只取 `pay_ledger_type`，凭证唯一键落在 ledger 的唯一约束上。
2. 支付成功与退款结果只认验签通过的渠道通知和服务端主动查询；客户端 SDK 带回的结果只触发一次查询。判定前逐项核对应用与商户标识、单号、金额、状态清单，任一不符不迁移、记录并告警。
3. 状态字段只经生成的 `transition()`，迁移一律 CAS；先取业务对象级锁再重读再判断；通知重复、通知与查询并发只生效一次。
4. 先查后关：未向渠道确认「已关闭」不置 CLOSED；「单据不存在」不等于已关闭；CLOSED 的单不得再变为 PAID，渠道侧仍有收款的登记异常收款。
5. 金额是整数分，只经 `@couli/money`（向渠道传元的换算与通知金额解析都不经浮点）；时间只读注入的 `Clock`；会计日只用 `@couli/domain`。
6. 商户私钥、APIv3 密钥、应用私钥只读环境变量名、由 KMS / 环境注入；缺失时 fail-close（不下单、不处理通知）。调起参数、通知原文里的个人信息不进日志；不返回渠道侧用户标识。
7. 外部写先落单：向渠道下单、关单、退款前先写本地记录与尝试行；渠道应答只有 ok / unknown，未知结果只查询、不用同一单号重提。
8. 入口边界：下单与取调起参数只限原生 App（access_token、请求签名、Idempotency-Key）；H5、JSBridge、Agent 不得调用；通知入口不带登录态、不返回业务信息。
9. 只读写本模块的表；别的模块的数据只经对方 `index.ts` 导出的端口；队列只经 `JobQueue`，入队与业务写在同一事务。
10. 日志只用 pino，不打金额以外的个人信息；渠道事实的来源在代码注释里注明文档出处，未实测的能力不写成事实。
