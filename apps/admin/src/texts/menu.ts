// Sidebar group and menu labels (design-hifi Adm* boards; order lives in resources/index.ts).
// Admin copy stays here, not in contracts/texts.default.json (规划/03 §9).
export const menuTexts = {
  groups: {
    'users-orders': '用户与订单',
    funds: '资金',
    operations: '运营',
    'rules-config': '规则与配置',
    'risk-ai': '风控与 AI',
    data: '数据',
    system: '系统',
  },
  items: {
    users: '用户查询',
    orders: '订单查询',
    claims: '找回审核',
    withdrawals: '提现审核',
    'settle-bills': '月结账单',
    ledger: '余额流水',
    'fund-ledger': '平台资金台账',
    recon: '对账与差错',
    adjustments: '调账与核销',
    'pay-orders': '支付单',
    pages: '首页配置',
    pools: '商品池',
    content: '内容管理',
    messages: '消息模板',
    'app-versions': '版本管理',
    'commission-rules': '分佣规则',
    config: '配置中心',
    switches: '紧急开关',
    unions: '联盟账号与推广位',
    risk: '风控',
    'agent-traces': 'AI 助手记录',
    reports: '报表',
    admins: '后台账号与权限',
    'audit-logs': '操作日志',
  },
} as const;

export type MenuGroupKey = keyof typeof menuTexts.groups;
export type MenuItemId = keyof typeof menuTexts.items;
