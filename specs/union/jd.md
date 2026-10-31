# 京东订单映射（B1-04zb）

接口 `jd.union.open.order.row.query`，实现在 `apps/api/src/modules/union/infra/jd/orders.ts`。本文件记本单定下的映射；依据 D10-520、D10-522。

## 请求

- 业务参数只有 `orderReq`：`pageIndex`（从 1）、`pageSize` 200、`type` 3（按更新时间）、`startTime`、`endTime`（GMT+8 的 `yyyy-MM-dd HH:mm:ss`）。
- 不带 `positionId`：它不是过滤参数。不带 `fields`：只影响商品与类目附加信息，这里不映射。
- 时间窗按毫秒原值判：from < to、跨度 ≤ 1 小时、from ≥ 当前时刻 − 90 天，不合格 `invalid_dto`、不发请求；拆窗归 order-sync。

## 字段对照

| DTO 字段 | 报文字段 | 说明 |
| --- | --- | --- |
| `sub_order_id` | `id` | 原文字符串 |
| `order_id` | `orderId` | 原文字符串 |
| `parent_order_id` | `parentId` | 0 或缺键为 null |
| `item_id` | `itemId` / `skuId` | 按商品键模式：item 取 `itemId` 全串，sku 取 `skuId`；缺值为 null，不互相顶替 |
| `promotion_slot` | `positionId` | 原文字符串，缺键为 null |
| `attr_params.sub_union_id` | `subUnionId` | 空串或缺键为 null；`relation_id`、`custom_parameters` 恒为 null |
| `raw_status` | `validCode` | 原文字符串；不映射订单状态 |
| `modified_at` | `modifyTime` | 必填 |
| `received_at` | `finishTime` | 空串或缺键为 null |
| `settled_at` | 无 | 恒为 null；`payMonth` 只是预估，不读 |
| `est_commission_fen` | `estimateFee` | 保留原值，可为负 |
| `commission_fen` | `estimateFee` | 负值取 0 |
| `settle_commission_fen` | `actualFee` | 见下节 |
| `paid_fen` | `actualCosPrice` / `estimateCosPrice` | 见下节 |
| `service_fee_fen` | 无 | 不给 |
| `raw_payload_id` | 无 | 该页归档行 id，取传输回传的元数据，不读报文 |

报文里的其他字段（含图片）不读、不进 DTO。

## 金额

元转分用 `@couli/money` 的 `yuanStrToFen`，只认报文数字的原文（BR-CALC-26），两位小数以外数学 floor。要读的金额字段缺失或非数字时整页 `invalid_dto`，不按 0 处理。

- **`settle_commission_fen`**：只有 `validCode` 为 17 或 18 时取 `actualFee`，其余一律 null。原因：未完成单的 `actualFee` 是 0.0，而 orders 取 `coalesce(settle, est)`，给 0n 就把预估佣金冲成 0。17 / 18 下退款后真为 0 时才是 0n。
- **`paid_fen`**：17 或 18 取 `actualCosPrice`，其余取 `estimateCosPrice`。两个原值都留在归档的原始报文里。
- **只读用得上的字段**：17 / 18 不读 `estimateCosPrice`，其余状态不读 `actualFee`、`actualCosPrice`；没读的字段缺失、为负、非数字都不影响该行。
- **负数（D10-522）**：`est_commission_fen`、`settle_commission_fen` 保留原值，`'-3.20'` → -320，`'-3.205'` → -321。`commission_fen`、`paid_fen` 必填非负，取 0；原值留在归档报文。

## 付款时点

| `validCode` | `paid_at` | `deposit_paid_at` |
| --- | --- | --- |
| 24（已付定金） | null | `orderTime` |
| 15（待付款） | null | null |
| 其余（16、17、18 与各类无效码） | `orderTime` | null |

这是**下单时刻近似付款时刻**：文档列的 `orderPayTime` 实际不出现，只能用 `orderTime`。15 不读 `orderTime`。

适配器只为金额与付款时点读 `validCode`，不判订单状态，不丢弃无效单，不按推广位过滤。

## 时间

全部按 GMT+8 解析，与进程时区无关。不存在的时刻（如 2 月 30 日）算不合格，报 `invalid_dto`。

## 翻页与空页

每次 `listOrders` 取一页，每页单独经配额治理（`listOrdersMetering = 'per_request'`）；`hasMore` 为 true 时 `nextCursor` 指下一页。

`hasMore` 的实际含义是「本页已满」，不是「后面还有」（D10-524，实测：pageSize=1 取只有 1 行的窗口，第 1 页 1 行、`hasMore` 为 true，第 2 页 `data` 与 `hasMore` 两键都缺）。所以行数恰为页大小整数倍的窗口会多取一页，那一页两键都缺，算正常翻完。

| 内层 200 的形状 | 结果 |
| --- | --- |
| 任何一页 `data`、`hasMore` 都缺（无单时间窗与满页后的下一页都是这样） | 空页，翻完 |
| `data` 为 `[]` 且 `hasMore` 为 false | 空页 |
| `data` 为非空数组，`hasMore` 为布尔 | 正常页 |
| 缺 `data` 但有 `hasMore`（任意值） | `invalid_dto` |
| `data` 不是数组（含 null） | `invalid_dto` |
| 有 `data` 但缺 `hasMore`，或 `hasMore` 非布尔 | `invalid_dto` |
| `hasMore` 为 true 而 `data` 为空数组 | `invalid_dto` |
