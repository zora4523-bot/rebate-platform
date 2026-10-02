// GENERATED FILE. Do not edit by hand.
// Source: contracts/enums/*.yaml
// Regenerate: pnpm contracts:codegen (drift is checked by pnpm contracts:check)

/**
 * 权限点 key；标 step-up 的权限点每次操作都须二次验证（见 04 §11 与 specs/permissions.yaml）
 * Source: 规划/04 §11（拍板第二批 §8 ADD-04、ADD-05） (contracts/enums/admin.yaml).
 */
export const admin_permission = [
  "user.list", // 用户列表浏览、筛选（非敏感字段）
  "user.lookup", // 按 UID、完整手机号或订单号逐个查询
  "pii.reveal_phone", // 查看完整手机号（step-up）
  "pii.reveal_identity", // 查看完整身份证号、收款账号（step-up）
  "fund.view", // 单个用户流水、提现单、对账明细
  "audit.view_all", // 全部审计日志只读
  "export", // 导出
  "content.page", // 首页配置发布 / 回滚、草稿预览二维码
  "content.pool", // 商品池、淘礼金池
  "content.article", // 帮助中心、返利规则、公告、消息模板
  "content.agreement", // 协议发布与提高最低版本 / 标记重签（step-up）
  "content.poster", // 海报背景图上传、审核
  "config.general", // 普通配置
  "config.risk", // 风控规则与阈值（step-up）
  "config.business", // 返利规则版本、费率、提现规则与限额、自动到账设置（step-up）
  "switch.all", // 全部紧急开关（step-up）
  "switch.payout", // 仅 withdraw.enabled、payout.enabled、payout.queue_paused（step-up）
  "risk.freeze", // 冻结 / 解冻（step-up）
  "risk.ban", // 封禁 / 解封（step-up）
  "risk.blocklist", // 黑名单增删（step-up）
  "risk.appeal", // 申诉处理
  "union.binding_reset", // 用户联盟授权重置（step-up）
  "union.binding_disable", // 用户联盟授权停用返利 / 恢复（step-up）
  "union.account_auth", // 站长联盟授权管理（step-up）
  "user.level", // 调等级（step-up）
  "user.inviter", // 改上级（step-up）
  "order.view", // 订单查询、手动同步
  "order.claim", // 找回、维权处理
  "order.assign", // 订单归属变更（step-up）
  "order.hold", // 订单 hold / unhold
  "order.restore", // 订单平台恢复、申诉恢复差错单（step-up）
  "ticket.handle", // 客服工单处理
  "ticket.data_export", // 个人信息副本导出（step-up）
  "withdraw.review", // 提现审核、驳回
  "payout.execute", // 执行打款、needs_manual 处置（step-up）
  "payout.manual_entry", // 线下打款补录（step-up）
  "settle.bill", // 月结账单确认、撤销定时、驳回、继续执行、补充批次（step-up）
  "settle.statement_upload", // 联盟结算明细上传
  "fund.adjust", // 人工调账（step-up）
  "fund.writeoff", // 坏账核销（step-up）
  "fund.settle_adjust", // 补差批次（step-up）
  "fund.recon", // 对账与差错单处理
  "agent.trace", // Agent trace 查询
] as const;
export type AdminPermission = (typeof admin_permission)[number];

/**
 * 余额流水类型，共 13 种，细分只用 sub_type；用户侧名称见 BR-TEXT-19
 * Source: 规划/04 §2.4；BR-FUND-15；08 §13.4 (contracts/enums/fund.yaml).
 */
export const ledger_type = [
  "REBATE_CREDIT", // 自购返利入账（+）
  "SHARE_CREDIT", // 分享收益入账（+）
  "REFERRAL_CREDIT", // 邀请分佣入账（+，直推 / 间推）
  "CLAWBACK", // 订单扣回（−，含入账后部分退款）
  "SETTLE_ADJUST", // 结算补差（±）
  "WITHDRAW_FREEZE", // 提现冻结（可用 → 冻结）
  "WITHDRAW_PAID", // 提现出金（冻结 −）
  "WITHDRAW_RETURN", // 提现退回（冻结 → 可用）
  "WITHDRAW_FEE", // 提现手续费（冻结 −，MVP 为 0）
  "TAX_WITHHOLD", // 代扣个税（冻结 −）
  "REWARD", // 活动奖励（+，P1）
  "ADMIN_ADJUST", // 人工调账（±）
  "BAD_DEBT_WRITEOFF", // 负余额核销（+）
] as const;
export type LedgerType = (typeof ledger_type)[number];

/**
 * REFERRAL_CREDIT 的 sub_type；INDIRECT 只在间推开关开启的规则版本下产生
 * Source: 规划/04 §2.4；BR-CALC-05 (contracts/enums/fund.yaml).
 */
export const referral_credit_sub_type = [
  "DIRECT", // 直推
  "INDIRECT", // 间推
] as const;
export type ReferralCreditSubType = (typeof referral_credit_sub_type)[number];

/**
 * clawback_sub_type
 * Source: 规划/04 §2.4；BR-FUND-08 (contracts/enums/fund.yaml).
 */
export const clawback_sub_type = [
  "FULL", // 全额扣回
  "PART_REFUND", // 入账后部分退款
  "RIGHTS", // 维权
  "PUNISH", // 处罚
] as const;
export type ClawbackSubType = (typeof clawback_sub_type)[number];

/**
 * settle_adjust_sub_type
 * Source: 规划/04 §2.4；BR-CALC-14 (contracts/enums/fund.yaml).
 */
export const settle_adjust_sub_type = [
  "SETTLE_DIFF", // 结算差异
  "PRICE_COMPARE", // 比价
  "PRICE_PROTECT", // 价保
] as const;
export type SettleAdjustSubType = (typeof settle_adjust_sub_type)[number];

/**
 * reward_sub_type
 * Source: 规划/04 §2.4（P1） (contracts/enums/fund.yaml).
 */
export const reward_sub_type = [
  "newbie", // 新人
  "checkin", // 签到
  "invite", // 邀请
] as const;
export type RewardSubType = (typeof reward_sub_type)[number];

/**
 * 人工调账原因码，含义与流程只在 BR-FUND-24 维护
 * Source: 规划/04 §2.4；BR-FUND-24 (contracts/enums/fund.yaml).
 */
export const admin_adjust_sub_type = [
  "RESTORE", // 订单恢复与申诉恢复（BR-FUND-22）
  "RECON_FIX", // 对账修正
  "PAYOUT_RECOVERY", // 打款追回
  "ACCOUNT_CLOSED", // 注销放弃余额转平台收入
  "OTHER", // 其他
] as const;
export type AdminAdjustSubType = (typeof admin_adjust_sub_type)[number];

/**
 * 受益角色；indirect 只在所选规则版本 indirect_enabled=true 时出现；客户端遇未知值按通用收入显示
 * Source: 规划/04 §2.5；BR-CALC-04、BR-CALC-05 (contracts/enums/fund.yaml).
 */
export const beneficiary_role = [
  "self", // 本人自购
  "share", // 分享者
  "direct", // 直推上级
  "indirect", // 间推上级
] as const;
export type BeneficiaryRole = (typeof beneficiary_role)[number];

/**
 * commission_splits.beneficiaries[].forfeit_reason，受益人份额被剥夺的原因
 * Source: 08 §13.2；BR-CALC-13 (contracts/enums/fund.yaml).
 */
export const forfeit_reason = [
  "banned", // 封禁
  "deleted", // 注销
  "minor", // 已识别未满 18 周岁
] as const;
export type ForfeitReason = (typeof forfeit_reason)[number];

/**
 * commission_rule_status
 * Source: 规划/04 §2.5；BR-CALC-11、BR-CALC-22 (contracts/enums/fund.yaml).
 */
export const commission_rule_status = [
  "draft", // 草稿
  "published", // 已发布
  "revoked", // 已撤销（只能撤销未生效版本）
] as const;
export type CommissionRuleStatus = (typeof commission_rule_status)[number];

/**
 * 所得类型；SELF_REBATE 停用，编码保留不复用，不列入
 * Source: 规划/04 §2.4；BR-WDR-20；拍板第二批 FUND-04 (contracts/enums/fund.yaml).
 */
export const income_type = [
  "SERVICE_FEE", // 全部佣金收入（劳务报酬，合并累计计税）
  "INCIDENTAL", // 活动奖励（偶然所得，P1）
] as const;
export type IncomeType = (typeof income_type)[number];

/**
 * 终态 REJECTED、PAID_API、PAID_MANUAL、FAILED；用户文案见 BR-TEXT-06
 * Source: 规划/04 §2.4；BR-WDR-08 (contracts/enums/fund.yaml).
 */
export const withdrawal_status = [
  "PENDING_REVIEW", // 审核中
  "APPROVED", // 已审核待执行
  "REJECTED", // 已驳回
  "PAYING", // 打款中或结果未知
  "PAID_API", // 接口确认成功
  "PAID_MANUAL", // 人工打款成功
  "FAILED", // 打款失败
] as const;
export type WithdrawalStatus = (typeof withdrawal_status)[number];

/**
 * withdrawals.reject_reason_code；前 5 个人工可选，NEGATIVE_BALANCE 系统专用
 * Source: 规划/04 §2.4；BR-WDR-10、BR-WDR-05 (contracts/enums/fund.yaml).
 */
export const withdraw_reject_reason = [
  "RISK_SUSPECT", // 风险嫌疑
  "ORDER_ABNORMAL", // 订单异常
  "PAYEE_INFO_INVALID", // 收款信息无效
  "USER_REQUEST", // 用户申请撤销
  "OTHER", // 其他
  "NEGATIVE_BALANCE", // 余额为负（系统专用）
] as const;
export type WithdrawRejectReason = (typeof withdraw_reject_reason)[number];

/**
 * withdrawals.hold_reason，W9 回到 APPROVED 的原因
 * Source: 规划/04 §2.4；BR-WDR-13、BR-WDR-17 (contracts/enums/fund.yaml).
 */
export const withdrawal_hold_reason = [
  "payout_disabled", // 打款开关关闭
  "queue_paused", // 打款队列暂停
  "member_blocked", // 用户受限
  "single_cap", // 单笔上限
  "daily_cap", // 单日上限
  "payer_side_after_transfer", // 转账后付款方问题
] as const;
export type WithdrawalHoldReason = (typeof withdrawal_hold_reason)[number];

/**
 * NEGATIVE_BALANCE_OTHER 随单一余额停用，编码不复用，不列入
 * Source: 规划/04 §2.4；BR-WDR-05；拍板第二批 §8 ADD-06 (contracts/enums/fund.yaml).
 */
export const withdrawal_blocked_reason = [
  "NEGATIVE_BALANCE", // 用户余额为负
] as const;
export type WithdrawalBlockedReason = (typeof withdrawal_blocked_reason)[number];

/**
 * withdrawal_manual_resolution
 * Source: 规划/04 §2.4；BR-WDR-15 (contracts/enums/fund.yaml).
 */
export const withdrawal_manual_resolution = [
  "paid", // 已打款（→ PAID_API）
  "failed", // 失败（→ FAILED）
] as const;
export type WithdrawalManualResolution = (typeof withdrawal_manual_resolution)[number];

/**
 * withdraw_holds.reason
 * Source: 规划/04 §2.4；BR-WDR-05、BR-WDR-15、BR-FUND-19 (contracts/enums/fund.yaml).
 */
export const withdraw_hold_kind = [
  "manual", // 人工冻结
  "recon_diff", // 对账差异
  "ledger_mismatch", // 账务差异
  "manual_failed_watch", // 人工失败观察
] as const;
export type WithdrawHoldKind = (typeof withdraw_hold_kind)[number];

/**
 * withdrawal_review_mode
 * Source: 规划/04 §2.4；BR-WDR-30 (contracts/enums/fund.yaml).
 */
export const withdrawal_review_mode = [
  "auto", // 系统按规则组审核并打款
  "manual", // 人工审核
] as const;
export type WithdrawalReviewMode = (typeof withdrawal_review_mode)[number];

/**
 * payout_accounts.payout_method 与 withdrawals.payout_channel
 * Source: 规划/04 §2.4；BR-WDR-02、BR-WDR-32 (contracts/enums/fund.yaml).
 */
export const payout_method = [
  "alipay", // 支付宝
  "bank_card", // 本人银行卡
] as const;
export type PayoutMethod = (typeof payout_method)[number];

/**
 * payout_batch_kind
 * Source: 规划/04 §2.4；BR-WDR-30 (contracts/enums/fund.yaml).
 */
export const payout_batch_kind = [
  "manual", // 人工批次
  "auto", // 自动批次
] as const;
export type PayoutBatchKind = (typeof payout_batch_kind)[number];

/**
 * bad_debt_writeoff_status
 * Source: 规划/04 §2.5；BR-FUND-12 (contracts/enums/fund.yaml).
 */
export const bad_debt_writeoff_status = [
  "PENDING", // 待批准
  "APPROVED", // 已批准
  "CANCELLED", // 已取消
] as const;
export type BadDebtWriteoffStatus = (typeof bad_debt_writeoff_status)[number];

/**
 * 月结账单状态由批次派生、不入库
 * Source: 规划/04 §2.5；BR-FUND-04 (contracts/enums/fund.yaml).
 */
export const settle_batch_status = [
  "DRAFT", // 草稿
  "CONFIRMED", // 已确认
  "EXECUTING", // 执行中
  "PARTIAL", // 部分执行
  "DONE", // 已完成
  "CANCELLED", // 已取消
] as const;
export type SettleBatchStatus = (typeof settle_batch_status)[number];

/**
 * settle_mode
 * Source: 规划/04 §2.5；BR-FUND-04 (contracts/enums/fund.yaml).
 */
export const settle_mode = [
  "IMMEDIATE", // 立即执行
  "SCHEDULED", // 定时执行
] as const;
export type SettleMode = (typeof settle_mode)[number];

/**
 * settle_batch_item_result
 * Source: 规划/04 §2.5；BR-FUND-04 (contracts/enums/fund.yaml).
 */
export const settle_batch_item_result = [
  "credited", // 已入账
  "skipped", // 已跳过
  "deferred", // 已顺延
] as const;
export type SettleBatchItemResult = (typeof settle_batch_item_result)[number];

/**
 * recon_diff_type
 * Source: 规划/04 §2.5；BR-FUND-04、BR-FUND-19、BR-FUND-22、BR-FUND-23 (contracts/enums/fund.yaml).
 */
export const recon_diff_type = [
  "union_mismatch", // 联盟对账差异（R1）
  "channel_mismatch", // 通道对账差异（R2）
  "ledger_mismatch", // 内部日终差异（R3）
  "platform_restore", // 已作废订单被平台恢复
  "month_end_unbalanced", // 月末三项不平
  "settle_amount_mismatch", // 月结账单金额不一致
  "settle_missing", // 应结未结
  "appeal_restore", // 申诉撤销后恢复订单
] as const;
export type ReconDiffType = (typeof recon_diff_type)[number];

/**
 * recon_diff_status
 * Source: 规划/04 §2.5；08 §13.6 (contracts/enums/fund.yaml).
 */
export const recon_diff_status = [
  "open", // 待处理
  "processing", // 处理中
  "adjusted", // 已调账
  "written_off", // 已核销
] as const;
export type ReconDiffStatus = (typeof recon_diff_status)[number];

/**
 * GET /v1/me 返回的身份等级
 * Source: 规划/04 §2.5；BR-ID-01 (contracts/enums/identity.yaml).
 */
export const identity_level = [
  "basic", // 基本模式
  "guest", // 游客
  "member", // 已登录
  "phone", // 已绑手机号
  "realname", // 已实名
] as const;
export type IdentityLevel = (typeof identity_level)[number];

/**
 * 第三方登录身份来源（user_oauth.provider）；手机号验证码登录不属于此列
 * Source: 规划/04 §6.1；BR-ID-04 (contracts/enums/identity.yaml).
 */
export const login_provider = [
  "wechat", // 微信（unionid）
  "apple", // Sign in with Apple（sub）
  "huawei", // 华为账号（unionID，M-公开）
] as const;
export type LoginProvider = (typeof login_provider)[number];

/**
 * sms_purpose
 * Source: 规划/04 §6.1；BR-ID-05 (contracts/enums/identity.yaml).
 */
export const sms_purpose = [
  "login", // 登录
  "bind", // 绑定手机号
  "step_up", // 二次验证
] as const;
export type SmsPurpose = (typeof sms_purpose)[number];

/**
 * step_up_token 的 action，须与所调接口一致
 * Source: 规划/04 §2.5、§5；BR-ID-08 (contracts/enums/identity.yaml).
 */
export const step_up_action = [
  "withdraw", // POST /v1/withdrawals
  "payout_account_change", // PUT /v1/me/payout-account
  "phone_change", // POST /v1/me/phone（更换）
  "account_deletion", // POST /v1/me/deletion
] as const;
export type StepUpAction = (typeof step_up_action)[number];

/**
 * consent_type
 * Source: 08 §13.2；BR-ID-12、BR-WDR-31 (contracts/enums/identity.yaml).
 */
export const consent_type = [
  "privacy", // 隐私政策
  "agreement", // 用户协议
  "ai_third_party", // AI 第三方处理
  "id_verification", // 实名授权
  "personalization", // 个性化推荐
  "labor_agreement", // 劳务协议
] as const;
export type ConsentType = (typeof consent_type)[number];

/**
 * 不设 cooling，释放后冷却用 released + cooldown_until；无用户自助换绑
 * Source: 规划/04 §2.5；BR-ID-19、BR-ID-20 (contracts/enums/identity.yaml).
 */
export const union_binding_status = [
  "unbound", // 未绑定
  "pending_auth", // 授权中
  "active", // 有效
  "invalid", // 已失效，需重新授权
  "released", // 已释放
  "blocked", // 已停用
] as const;
export type UnionBindingStatus = (typeof union_binding_status)[number];

/**
 * union_binding_blocked_reason
 * Source: 规划/04 §2.5；BR-ID-20；拍板第二批 OPS-11 (contracts/enums/identity.yaml).
 */
export const union_binding_blocked_reason = [
  "ban", // 封禁
  "admin_disable", // 后台停用返利（可恢复）
  "deletion", // 注销
] as const;
export type UnionBindingBlockedReason = (typeof union_binding_blocked_reason)[number];

/**
 * user_risk_state.state，risk 模块唯一写者
 * Source: 规划/04 §2.5；BR-ID-31 (contracts/enums/identity.yaml).
 */
export const risk_state = [
  "normal", // 正常
  "frozen", // 冻结（可设期限 frozen_until）
  "appealing", // 申诉中
  "banned", // 封禁（永久）
] as const;
export type RiskState = (typeof risk_state)[number];

/**
 * realname_status
 * Source: 规划/04 §2.5 (contracts/enums/identity.yaml).
 */
export const realname_status = [
  "none", // 未实名
  "verified", // 已实名
  "failed", // 核验失败
] as const;
export type RealnameStatus = (typeof realname_status)[number];

/**
 * deletion_status
 * Source: 规划/04 §2.5；BR-ID-27 (contracts/enums/identity.yaml).
 */
export const deletion_status = [
  "cooling", // 冷静期
  "processing", // 处理中
  "done", // 已注销
  "cancelled", // 已撤回
] as const;
export type DeletionStatus = (typeof deletion_status)[number];

/**
 * appeal_status
 * Source: 规划/04 §2.5；BR-ID-36 (contracts/enums/identity.yaml).
 */
export const appeal_status = [
  "processing", // 处理中
  "upheld", // 维持
  "revoked", // 撤销
] as const;
export type AppealStatus = (typeof appeal_status)[number];

/**
 * appeal_target_type
 * Source: 规划/04 §6.1；BR-ID-36 (contracts/enums/identity.yaml).
 */
export const appeal_target_type = [
  "account", // 账号
  "order", // 订单
] as const;
export type AppealTargetType = (typeof appeal_target_type)[number];

/**
 * 消息模板编码；UNION_AUTH_EXPIRING、UNION_AUTH_EXPIRED 只发站长手机号，不属于用户通知分类
 * Source: 规划/04 §2.5；BR-TEXT-09、BR-TEXT-20 (contracts/enums/ops.yaml).
 */
export const notify_template_code = [
  "ORDER_TRACKED", // 订单已跟单
  "ORDER_INVALID", // 订单失效
  "CREDITED", // 月结批次入账（按受益人汇总）
  "CLAWBACK", // 扣回
  "WD_SUCCESS", // 提现成功
  "WD_REJECTED", // 提现驳回
  "WD_FAILED", // 提现失败
  "WD_OVERDUE", // 提现审核超时
  "CLAIM_RESULT", // 找回结果
  "RISK_STATE_CHANGED", // 风控状态变化（只发站内信）
  "APPEAL_RESULT", // 申诉结果（只发站内信）
  "DELETION_PROGRESS", // 注销进度（只发站内信）
  "BALANCE_ADJUSTED", // 人工调账调减（只发站内信）
  "SMS_CODE", // 短信验证码
  "UNION_AUTH_EXPIRING", // 站长授权即将到期（短信）
  "UNION_AUTH_EXPIRED", // 站长授权已过期（短信）
] as const;
export type NotifyTemplateCode = (typeof notify_template_code)[number];

/**
 * 用户通知分类；交易与提现模板都归 service，MVP 只开放 service 开关，subscription、marketing 预埋不展示（待负责人确认）
 * Source: 规划/04 §2.5；拍板第二批 OPS-16；BR-WATCH-19 (contracts/enums/ops.yaml).
 */
export const notify_category = [
  "service", // 服务类
  "subscription", // 订阅类（预埋）
  "marketing", // 营销类（预埋）
] as const;
export type NotifyCategory = (typeof notify_category)[number];

/**
 * ticket_type
 * Source: 规划/04 §2.5；拍板第二批 OPS-08、OPS-19、FUND-20 (contracts/enums/ops.yaml).
 */
export const ticket_type = [
  "appeal_unauth", // 未登录申诉
  "realname_correction", // 实名更正
  "phone_change", // 旧手机号不可用换号
  "ai_report", // AI 举报
  "data_export", // 个人信息副本
  "withdraw_cancel", // 提现撤销申请
  "other", // 其他
] as const;
export type TicketType = (typeof ticket_type)[number];

/**
 * ticket_status
 * Source: 规划/04 §2.5；拍板第二批 OPS-08 (contracts/enums/ops.yaml).
 */
export const ticket_status = [
  "open", // 待处理
  "processing", // 处理中
  "waiting_user", // 等待用户
  "resolved", // 已解决
  "closed", // 已关闭
] as const;
export type TicketStatus = (typeof ticket_status)[number];

/**
 * 分销等级，晋升只看本人推广订单；用户端不展示（拍板第二批 OPS-20）
 * Source: 规划/04 §2.5 (contracts/enums/ops.yaml).
 */
export const user_level = [
  "L1", // 一级
  "L2", // 二级
  "L3", // 三级
] as const;
export type UserLevel = (typeof user_level)[number];

/**
 * agent_intent
 * Source: 规划/04 §2.5 (contracts/enums/ops.yaml).
 */
export const agent_intent = [
  "find_by_link", // 按链接找货
  "search", // 搜索
  "refine", // 追加条件
  "order_query", // 查订单
  "rule_qa", // 规则问答
  "handoff", // 转人工
  "clarify", // 澄清
  "out_of_scope", // 范围外
] as const;
export type AgentIntent = (typeof agent_intent)[number];

/**
 * Agent 卡片类型；watch_confirm、watch_list 为 P1，MVP 不注册，不列入
 * Source: 规划/04 §8.3；08 §13.2 (contracts/enums/ops.yaml).
 */
export const agent_card_type = [
  "product_list", // 商品列表
  "rebate_quote", // 查返利
  "order_status", // 订单状态
  "claim_draft", // 找回草稿
  "handoff", // 转人工
  "auth_required", // 需要授权
  "notice", // 提示
  "rule_ref", // 规则引用
] as const;
export type AgentCardType = (typeof agent_card_type)[number];

/**
 * SSE done 事件的 finish_reason
 * Source: 规划/04 §8.2；BR-AI-01、BR-AI-14、BR-AI-16、BR-AI-18 (contracts/enums/ops.yaml).
 */
export const agent_finish_reason = [
  "stop", // 正常结束
  "cancelled", // 已取消
  "limit", // 达到上限
  "budget", // 预算用完
  "error", // 出错
  "auth_required", // 需要授权
  "safety", // 安全拦截
  "fallback", // 无模型降级出卡
  "timeout", // 单轮时限到
] as const;
export type AgentFinishReason = (typeof agent_finish_reason)[number];

/**
 * watch_status
 * Source: 规划/04 §2.5；BR-WATCH-10（P1） (contracts/enums/ops.yaml).
 */
export const watch_status = [
  "active", // 生效中
  "paused", // 已暂停
  "unavailable", // 不可用
  "expired", // 已过期
  "cancelled", // 已取消
] as const;
export type WatchStatus = (typeof watch_status)[number];

/**
 * watch_event_status
 * Source: 规划/04 §2.5；BR-WATCH-11（P1） (contracts/enums/ops.yaml).
 */
export const watch_event_status = [
  "pending", // 待发送
  "suppressed", // 已抑制
  "sent", // 已发送
] as const;
export type WatchEventStatus = (typeof watch_event_status)[number];

/**
 * 联盟订单状态，唯一写者 order-sync；SETTLED 只表示联盟结算，不表示回款或我方入账
 * Source: 规划/04 §2.3；BR-FUND-02 (contracts/enums/order.yaml).
 */
export const platform_status = [
  "DEPOSIT_PAID", // 预售已付定金
  "PAID", // 已付款
  "RECEIVED", // 已确认收货
  "SETTLED", // 联盟已结算
  "INVALID", // 已失效
] as const;
export type PlatformStatus = (typeof platform_status)[number];

/**
 * 返利状态，唯一写者 settlement；VOID、CLAWED_BACK 为终态
 * Source: 规划/04 §2.3；BR-FUND-01 (contracts/enums/order.yaml).
 */
export const rebate_status = [
  "UNATTRIBUTED", // 未归因（不对用户展示）
  "ESTIMATED", // 预估
  "WAITING", // 等待月结入账
  "CREDITED", // 已入账
  "VOID", // 已作废（终态）
  "CLAWED_BACK", // 已扣回（终态）
] as const;
export type RebateStatus = (typeof rebate_status)[number];

/**
 * 用户可见状态，接口按 BR-FUND-17 派生表派生、不入库；文案取字典 order_status.<值>（BR-TEXT-02）；WAITING_SETTLE 在月结口径下停用，不进契约
 * Source: 规划/04 §2.3；BR-FUND-17 (contracts/enums/order.yaml).
 */
export const display_status = [
  "PAID", // 见 BR-FUND-17 派生表
  "DEPOSIT_PAID", // 见 BR-FUND-17 派生表
  "WAITING", // 见 BR-FUND-17 派生表
  "CREDITING", // 见 BR-FUND-17 派生表
  "REVIEWING", // 见 BR-FUND-17 派生表
  "RIGHTS_PENDING", // 见 BR-FUND-17 派生表
  "CREDITED", // 见 BR-FUND-17 派生表
  "CREDITED_PART_CLAWED", // 见 BR-FUND-17 派生表
  "NO_REBATE", // 见 BR-FUND-17 派生表
  "INVALID", // 见 BR-FUND-17 派生表
  "CLAWED_BACK", // 见 BR-FUND-17 派生表
] as const;
export type DisplayStatus = (typeof display_status)[number];

/**
 * orders.hold_reason，不改 rebate_status
 * Source: 08 §13.6；BR-FUND-06 (contracts/enums/order.yaml).
 */
export const order_hold_reason = [
  "RISK", // 风控暂停入账
  "CS", // 客服暂停入账
] as const;
export type OrderHoldReason = (typeof order_hold_reason)[number];

/**
 * 订单原因码；NOT_TRACKED、EXPIRED_CLICK、OTHER_TLJ、RELATION_INVALID 不写入 orders.reason。CANCELLED 待 09 实测，启用前不写入
 * Source: 规划/04 §2.3；BR-TEXT-05；08 §13.2 (contracts/enums/order.yaml).
 */
export const order_reason = [
  "REFUND", // 退款
  "RIGHTS", // 维权
  "PUNISH", // 处罚
  "PRESALE_UNPAID", // 预售尾款未付
  "COMMISSION_ZERO", // 佣金为 0
  "OTHER", // 其他
  "BLACKLIST", // 黑名单
  "PART_REFUND", // 部分退款（差额类）
  "PRICE_COMPARE", // 比价（差额类）
  "PRICE_PROTECT", // 价保（差额类）
  "SETTLE_DIFF", // 结算差异（差额类）
  "NOT_TRACKED", // 未跟单
  "EXPIRED_CLICK", // 点击已过期
  "OTHER_TLJ", // 他人淘礼金
  "RELATION_INVALID", // 渠道关系失效
  "CANCELLED", // 订单取消（待定，启用前不写入）
] as const;
export type OrderReason = (typeof order_reason)[number];

/**
 * orders.diff_reason_code，差额原因只用这 4 个
 * Source: 规划/04 §2.3；BR-CALC-14；08 §13.2（settle_diff_reason） (contracts/enums/order.yaml).
 */
export const diff_reason = [
  "PART_REFUND", // 部分退款
  "PRICE_COMPARE", // 比价
  "PRICE_PROTECT", // 价保
  "SETTLE_DIFF", // 结算差异
] as const;
export type DiffReason = (typeof diff_reason)[number];

/**
 * order_rights.status；PROCESSING、WAIT_COMMISSION 使 rights_pending=true
 * Source: 规划/04 §2.3；BR-FUND-06 (contracts/enums/order.yaml).
 */
export const order_rights_status = [
  "PROCESSING", // 处理中
  "WAIT_COMMISSION", // 待扣佣
  "SUCCEEDED", // 维权成功
  "FAILED", // 维权失败
] as const;
export type OrderRightsStatus = (typeof order_rights_status)[number];

/**
 * claim_status
 * Source: 规划/04 §2.5；BR-ATTR-16、BR-ATTR-18 (contracts/enums/order.yaml).
 */
export const claim_status = [
  "submitted", // 已提交
  "auto_matched", // 全部子项 strong，待客服确认
  "manual_review", // 人工审核
  "approved", // 已通过
  "rejected", // 已驳回
  "cancelled", // 同步已自动归因给申请人
] as const;
export type ClaimStatus = (typeof claim_status)[number];

/**
 * claim_evidence_level
 * Source: 规划/04 §2.3；BR-ATTR-16 (contracts/enums/order.yaml).
 */
export const claim_evidence_level = [
  "strong", // 强
  "weak", // 弱
  "none", // 无
] as const;
export type ClaimEvidenceLevel = (typeof claim_evidence_level)[number];

/**
 * claim_items.decision，待审为 null
 * Source: 规划/04 §2.3；BR-ATTR-18 (contracts/enums/order.yaml).
 */
export const claim_item_decision = [
  "approved", // 通过
  "rejected", // 驳回
  "cancelled", // 同步已自动归因给申请人
] as const;
export type ClaimItemDecision = (typeof claim_item_decision)[number];

/**
 * 前 6 个客服可选，NOT_IN_POOL、ORDER_INVALID 系统专用
 * Source: 规划/04 §2.3；BR-ATTR-18 (contracts/enums/order.yaml).
 */
export const claim_reject_reason = [
  "NO_EVIDENCE", // 缺少证据
  "EXPIRED_CLICK", // 点击已过期
  "NOT_TRACKED", // 未跟单
  "OTHER_TLJ", // 他人淘礼金
  "FRAUD", // 欺诈
  "OTHER", // 其他
  "NOT_IN_POOL", // 不在未归因池（系统专用）
  "ORDER_INVALID", // 订单已失效（系统专用）
] as const;
export type ClaimRejectReason = (typeof claim_reject_reason)[number];

/**
 * 平台字符串编码，不使用数字；天猫是淘宝的 shop_type=tmall，不单独占编码。能力与阶段由平台字典表 platforms 记录，代码不按本列表判断能力
 * Source: 规划/04 §2.1；08 §13.2 (contracts/enums/platform.yaml).
 */
export const platform = [
  "taobao", // 淘宝 / 天猫（M-内测）
  "jd", // 京东（M-内测）
  "pdd", // 拼多多（M-内测）
  "meituan", // 美团（外卖、到店活动；P1，D15）
  "vip", // 唯品会（P1）
  "douyin", // 抖音（P1）
  "eleme", // 饿了么（P1，无商品形态）
  "kuaishou", // 快手（P2）
  "suning", // 苏宁（P2）
] as const;
export type Platform = (typeof platform)[number];

/**
 * platforms.key_stability，平台 product_key 派生的稳定性验证结论
 * Source: 规划/04 §2.1；BR-PROD-03 (contracts/enums/platform.yaml).
 */
export const key_stability = [
  "unverified", // 未验证
  "stable_24h", // 24 小时内稳定
  "stable_7d", // 7 天内稳定
  "unstable", // 不稳定
] as const;
export type KeyStability = (typeof key_stability)[number];

/**
 * 发起请求的客户端
 * Source: 规划/03 §4.2（请求头 X-Platform） (contracts/enums/platform.yaml).
 */
export const client_platform = [
  "ios", // iOS App
  "android", // Android App
  "harmony", // 鸿蒙 App
  "h5", // App 内或 App 外 H5
  "admin", // 管理后台
] as const;
export type ClientPlatform = (typeof client_platform)[number];

/**
 * 安装包渠道
 * Source: 规划/04 §5（请求头 X-Channel）；拍板第二批 TECH-18 (contracts/enums/platform.yaml).
 */
export const install_channel = [
  "appstore", // iOS App Store
  "official", // Android 通用包
  "huawei", // 华为渠道 Android 包
  "agc", // 鸿蒙 AGC
] as const;
export type InstallChannel = (typeof install_channel)[number];

/**
 * 接口的鉴权级别；optional = 带令牌按用户处理、不带按匿名处理
 * Source: 规划/04 §5（openapi 扩展 x-auth）；08 §13.6 (contracts/enums/platform.yaml).
 */
export const auth_level = [
  "none", // 不需要登录
  "optional", // 可选登录
  "login", // 需要登录
  "phone", // 需要已绑手机号
  "realname", // 需要已实名
] as const;
export type AuthLevel = (typeof auth_level)[number];

/**
 * 转链来源，转链请求必填，缺失或非法返回 20001。watch_alert 为 MVP 预埋（开关关闭，不对用户展示，BR-WATCH-19 待确认）；taolijin 在 tlj.enabled=off 期间服务端不接受；share_ext、wechat_bot、mcp 为 P1
 * Source: 规划/04 §2.2；BR-ATTR-08；08 §13.2 (contracts/enums/trade.yaml).
 */
export const scene = [
  "search", // 搜索结果
  "detail", // 商品详情
  "home_card", // 首页卡片
  "feed", // 信息流
  "clipboard", // 剪贴板识别
  "agent", // Agent
  "share", // 分享
  "h5", // H5（trade.convertAndOpen）
  "push", // 推送
  "taolijin", // 淘礼金（后续接入，D7）
  "watch_alert", // 提醒（MVP 预埋，关闭）
  "share_ext", // 分享扩展（P1）
  "wechat_bot", // 微信入口（P1）
  "mcp", // MCP（P1）
] as const;
export type Scene = (typeof scene)[number];

/**
 * 推广位场景，服务端由 scene 推出，不由客户端传入
 * Source: 规划/04 §2.2；BR-ATTR-08 (contracts/enums/trade.yaml).
 */
export const pid_scene = [
  "self_buy", // 自购
  "agent", // Agent
  "share", // 分享
  "taolijin", // 淘礼金（后续接入，首版不建）
  "fallback", // 兜底，不下发给用户
  "query", // 查价专用，不转链
] as const;
export type PidScene = (typeof pid_scene)[number];

/**
 * buy_type
 * Source: 规划/04 §2.3；BR-ATTR-08 (contracts/enums/trade.yaml).
 */
export const buy_type = [
  "self", // 自购
  "share", // 分享
] as const;
export type BuyType = (typeof buy_type)[number];

/**
 * buy_type 的判定依据
 * Source: 规划/04 §2.3；BR-ATTR-09 (contracts/enums/trade.yaml).
 */
export const scene_basis = [
  "pid", // 推广位
  "param", // 推广参数
  "fallback", // 兜底
] as const;
export type SceneBasis = (typeof scene_basis)[number];

/**
 * user_id 的来源，未归因为 null
 * Source: 规划/04 §2.3；BR-ATTR-09 (contracts/enums/trade.yaml).
 */
export const user_basis = [
  "param", // 推广参数
  "claim", // 找回
  "admin", // 管理员
] as const;
export type UserBasis = (typeof user_basis)[number];

/**
 * link_logs.event；只有 convert、open 且 result_code=0 算点击证据
 * Source: BR-ATTR-14 (contracts/enums/trade.yaml).
 */
export const link_event = [
  "convert", // 用户主动发起的 POST /v1/links/convert
  "precompute", // 保留取值，不再产生（出卡不预转链）
  "register", // 出卡登记 link_id
  "open", // POST /v1/links/{link_id}/open
] as const;
export type LinkEvent = (typeof link_event)[number];

/**
 * open 与 convert 请求体 installed，缺省 unknown；线上取值是字符串 "true" / "false" / "unknown"，不是 JSON 布尔
 * Source: BR-ATTR-27；规划/03 §4.5 (contracts/enums/trade.yaml).
 */
export const installed_state = [
  "true", // 已安装
  "false", // 未安装
  "unknown", // 未知（H5 固定为 unknown）
] as const;
export type InstalledState = (typeof installed_state)[number];

/**
 * open 的无返利原因；客户端只能传 auth_declined、auth_failed，relation_conflict、binding_blocked 由服务端判定
 * Source: 规划/04 §6.3；BR-ID-18 (contracts/enums/trade.yaml).
 */
export const no_rebate_reason = [
  "auth_declined", // 用户拒绝授权
  "auth_failed", // 授权失败
  "relation_conflict", // 渠道关系冲突
  "binding_blocked", // 绑定已停用
] as const;
export type NoRebateReason = (typeof no_rebate_reason)[number];

/**
 * 外跳方案 primary / fallbacks 每一项的类型
 * Source: 规划/03 §4.5；BR-ATTR-27 (contracts/enums/trade.yaml).
 */
export const jump_type = [
  "sdk", // 联盟 SDK
  "scheme", // 自定义 scheme
  "universal_link", // Universal Link / App Link / App Linking
  "h5", // H5 页面
  "copy_tpwd", // 复制口令
] as const;
export type JumpType = (typeof jump_type)[number];

/**
 * parse_input 命中项的类型
 * Source: 规划/04 §8.5 (contracts/enums/trade.yaml).
 */
export const input_kind = [
  "tpwd", // 口令
  "url", // 链接
  "text", // 文本
] as const;
export type InputKind = (typeof input_kind)[number];

/**
 * rebate_basis
 * Source: 规划/04 §8.3；BR-PRICE-07、BR-PRICE-08、BR-PRICE-21；BR-AI-11 (contracts/enums/trade.yaml).
 */
export const rebate_basis = [
  "normal", // 正常返利
  "price_compare_risk", // 比价风险（返利可能为 0）
  "no_rebate", // 无返利
  "amount_unknown", // 可返利，金额以订单为准（拼多多直链）
  "login_required", // 登录查看返利（游客卡，按平台开关）
] as const;
export type RebateBasis = (typeof rebate_basis)[number];

/**
 * availability
 * Source: 规划/04 §8.3 (contracts/enums/trade.yaml).
 */
export const availability = [
  "ok", // 可购买
  "off_shelf", // 已下架
  "coupon_gone", // 券已失效
  "ref_expired", // 商品信息已失效
  "price_unavailable", // 暂无法取价
  "unknown", // 未知
] as const;
export type Availability = (typeof availability)[number];

/**
 * match_tag
 * Source: 规划/04 §2.5、§8.3；BR-AI-24 (contracts/enums/trade.yaml).
 */
export const match_tag = [
  "matched", // 符合
  "relaxed", // 已放宽
  "spec_unconfirmed", // 规格待确认
] as const;
export type MatchTag = (typeof match_tag)[number];

/**
 * benefit
 * Source: 规划/04 §2.5 (contracts/enums/trade.yaml).
 */
export const benefit = [
  "coupon", // 有券
  "big_coupon", // 大额券
  "taolijin", // 淘礼金
  "subsidy", // 补贴
  "high_rebate", // 高返利
] as const;
export type Benefit = (typeof benefit)[number];

/**
 * sort
 * Source: 规划/04 §2.5；拍板第二批 TRADE-20（券后价与返利排序只排当前页） (contracts/enums/trade.yaml).
 */
export const sort = [
  "relevance", // 综合
  "sales_desc", // 销量从高到低
  "final_price_asc", // 券后价从低到高
  "rebate_desc", // 返利从高到低
] as const;
export type Sort = (typeof sort)[number];

/**
 * 素材淘礼金出资方判定；unknown 不宣称已判定为 third_party
 * Source: 规划/04 §2.5；BR-TEXT-15 (contracts/enums/trade.yaml).
 */
export const tlj_kind = [
  "ours", // 我方（A）
  "brand_open", // 品牌开放（B）
  "third_party", // 第三方（C）
  "unknown", // 未判定
] as const;
export type TljKind = (typeof tlj_kind)[number];

/** Every enum of contracts/enums, by name. */
export const enums = {
  admin_permission,
  ledger_type,
  referral_credit_sub_type,
  clawback_sub_type,
  settle_adjust_sub_type,
  reward_sub_type,
  admin_adjust_sub_type,
  beneficiary_role,
  forfeit_reason,
  commission_rule_status,
  income_type,
  withdrawal_status,
  withdraw_reject_reason,
  withdrawal_hold_reason,
  withdrawal_blocked_reason,
  withdrawal_manual_resolution,
  withdraw_hold_kind,
  withdrawal_review_mode,
  payout_method,
  payout_batch_kind,
  bad_debt_writeoff_status,
  settle_batch_status,
  settle_mode,
  settle_batch_item_result,
  recon_diff_type,
  recon_diff_status,
  identity_level,
  login_provider,
  sms_purpose,
  step_up_action,
  consent_type,
  union_binding_status,
  union_binding_blocked_reason,
  risk_state,
  realname_status,
  deletion_status,
  appeal_status,
  appeal_target_type,
  notify_template_code,
  notify_category,
  ticket_type,
  ticket_status,
  user_level,
  agent_intent,
  agent_card_type,
  agent_finish_reason,
  watch_status,
  watch_event_status,
  platform_status,
  rebate_status,
  display_status,
  order_hold_reason,
  order_reason,
  diff_reason,
  order_rights_status,
  claim_status,
  claim_evidence_level,
  claim_item_decision,
  claim_reject_reason,
  platform,
  key_stability,
  client_platform,
  install_channel,
  auth_level,
  scene,
  pid_scene,
  buy_type,
  scene_basis,
  user_basis,
  link_event,
  installed_state,
  no_rebate_reason,
  jump_type,
  input_kind,
  rebate_basis,
  availability,
  match_tag,
  benefit,
  sort,
  tlj_kind,
} as const;
export type EnumName = keyof typeof enums;
export type EnumValue<Name extends EnumName> = (typeof enums)[Name][number];
