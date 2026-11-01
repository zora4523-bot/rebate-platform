# 收款通道上线检查清单（B2-15k）

> 依据：规划/08 BR-PAY-03、04、05、06、08、09；规划/09 CAP-X-16（V-43）、CAP-X-17（V-44）。
> 适配器按官方文档快照写成（`docs-mirror/wechat-pay/`、`docs-mirror/alipay/`），**下面每一项都未实测**。
> 打开 `pay.enabled` 与渠道开关的前提见 BR-PAY-09 细则；`success_states` 等清单的增改须附实测样例。
> 实测通过后在对应项写日期与留样位置，并把 `specs/*-pay-error-map.csv` 对应行的 `verified` 改为 `yes`。

## 1. 渠道能力（CAP-X-16 微信、CAP-X-17 支付宝，两个渠道各跑一遍）

- [ ] 下单：微信 `POST /v3/pay/transactions/app`（金额、`time_expire`、`notify_url`）；支付宝本地签 orderStr，提交前渠道侧没有这张单。
- [ ] 调起：调起参数字段与签名（微信 `Sign=WXPay`；支付宝 orderStr 的编码）能被官方 SDK 接受。
- [ ] 三端调起：iOS、安卓、鸿蒙的最低 SDK 与渠道 App 版本，未安装渠道 App 时的表现，取消与失败的返回值（BR-PAY-09 ④）。
- [ ] 通知验签与解密：微信四个头、公钥 ID、时间窗、AES-256-GCM；支付宝待验签串（含空值参数的拼法）、`seller_id` 是否总带上（缺了判 rejected，由查询定结果）。
- [ ] 通知应答与重试：应答格式、重试间隔、重试次数。
- [ ] 查单：状态含义（`specs/*-pay-error-map.csv`），微信 404 + `ORDER_NOT_EXIST`、支付宝 40004 + `ACQ.TRADE_NOT_EXIST` 的实际返回。
- [ ] 查单应答里的身份字段：支付宝查单、退款查询文档没有 `seller_id` / `app_id`，适配器用本配置值填；核实这样做时身份核对只来自验签。
- [ ] 关单：微信 204、支付宝 10000 之后再查的结果；关单后还能否被支付；已过期单的关单错误码（关单错误一律再查，不靠错误码）。
- [ ] 支付宝 `TRADE_CLOSED` 也可能是「支付完成后全额退款」：核实它对 PENDING 单会不会出现。
- [ ] 支付宝 `TRADE_FINISHED`：实测前按不成功处理，查单记 warn `pay_trade_finished`，通知照常带回原状态。
- [ ] 退款：受理应答字段（微信 `amount`、支付宝 `refund_fee` 是累计还是单次）、退款时限、同一退款单号重提的语义（验证前不重提）。
- [ ] 退款查询与退款通知：微信 `CLOSED`、`ABNORMAL`（`refund_fail_states` 实测前为空，继续占额）；支付宝无退款信息的 10000、没有 `refund_status` 的应答。
- [ ] 账单格式：两家文档都没给可靠的文件格式（微信无列定义，支付宝无编码与压缩细节），文件大小上限是自定的 64 MiB、未实测。
- [ ] 费率与结算周期。

## 2. 环境与密钥

- [ ] KMS 放置密钥：prod 的收款密钥只存 KMS（BR-PAY-08 ②）。**现在适配器只读密钥文件，KMS 的取用方式尚未实现；未实现前 prod 不得开通。**
- [ ] 可读进程：只有 api、worker、admin 拿得到密钥，stream、payout 没有挂载也不读（BR-PAY-08 ①）。
- [ ] 沙箱网关地址：`PAY_ALIPAY_GATEWAY` 的实际地址未实测；微信测试商户走同一个 API 域名（未实测）。
- [ ] 通知公网可达与限流：`PAY_NOTIFY_BASE_URL` 的 https 证书、网关放行、不重定向、限流（BR-PAY-08 ③）。
- [ ] 切换步骤按 `infra/staging/README.md` 1.9；生产网关与 `PAY_CHANNEL_IMPL` 的启动拒绝已有规则测试。

## 3. 已知的保守行为（实测前保持，上线前要知道）

- **账单解析前 B2-15j 对账不跑**：账单下载成功也返回 `unknown` / `bill_format_unverified`，对账任务拿不到账单行。拿到真实样例后另开单写解析。
- **支付宝退款结果靠查询，通知会告警**：退款通知的 `refund_fee` 是该笔交易的总退款金额（`docs-mirror/alipay/app-pay/00dn78.md:43`），适配器如实带回、不做差额推算；同一单第二笔起的部分退款通知会因金额与退款单不符而只留存、告警、不迁移（BR-PAY-06 ④），结果以退款查询为准。这条告警在实测前是预期内的。
- **`channel_unconfigured`**：缺配置的渠道下单 50306、通知不处理，进程照常启动，只有启动时一条 `pay_channel_unavailable` warn。
