import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';

// Independent oracle transcribed from task §2 and sample-data.md §10/10.1. The missing pay.*
// and switch.pay contract keys are intentionally retained: the contract assertion must fail.
export const MENU = [
  ['用户与订单', 'users', '用户查询', ['user.list', 'user.lookup']],
  ['用户与订单', 'orders', '订单查询', ['order.view']],
  ['用户与订单', 'claims', '找回审核', ['order.claim']],
  ['资金', 'withdrawals', '提现审核', ['withdraw.review', 'payout.execute', 'payout.manual_entry']],
  [
    '资金',
    'settle-bills',
    '月结账单',
    ['settle.bill', 'settle.statement_upload', 'fund.settle_adjust'],
  ],
  ['资金', 'ledger', '余额流水', ['fund.view']],
  ['资金', 'fund-ledger', '平台资金台账', ['fund.cash_entry']],
  ['资金', 'recon', '对账与差错', ['fund.recon']],
  ['资金', 'adjustments', '调账与核销', ['fund.adjust', 'fund.writeoff']],
  ['资金', 'pay-orders', '支付单', ['pay.view', 'pay.refund', 'pay.resolve']],
  ['运营', 'pages', '首页配置', ['content.page']],
  ['运营', 'pools', '商品池', ['content.pool']],
  ['运营', 'content', '内容管理', ['content.article', 'content.agreement']],
  ['运营', 'messages', '消息模板', ['content.article', 'content.fund_terms']],
  ['运营', 'app-versions', '版本管理', ['content.app_version']],
  ['规则与配置', 'commission-rules', '分佣规则', ['config.business']],
  ['规则与配置', 'config', '配置中心', ['config.general', 'config.risk', 'config.business']],
  ['规则与配置', 'switches', '紧急开关', ['switch.all', 'switch.payout', 'switch.pay']],
  ['规则与配置', 'unions', '联盟账号与推广位', ['union.account_auth', 'union.pid']],
  ['风控与 AI', 'risk', '风控', ['risk.freeze', 'risk.ban', 'risk.blocklist', 'risk.appeal']],
  ['风控与 AI', 'agent-traces', 'AI 助手记录', ['agent.trace', 'agent.report']],
  ['数据', 'reports', '报表', 'authenticated'],
  ['系统', 'admins', '后台账号与权限', 'super'],
  ['系统', 'audit-logs', '操作日志', 'authenticated'],
] as const;

export const CASES: readonly {
  name: string;
  snapshot: PermissionSnapshot;
  ids: readonly string[];
  groups: readonly string[];
}[] = [
  {
    name: '超管',
    snapshot: { isSuper: true, permissions: [] },
    ids: MENU.map((row) => row[1]),
    groups: ['用户与订单', '资金', '运营', '规则与配置', '风控与 AI', '数据', '系统'],
  },
  {
    name: '风控小狸',
    snapshot: {
      isSuper: false,
      permissions: [
        'risk.freeze',
        'risk.ban',
        'risk.blocklist',
        'risk.appeal',
        'user.lookup',
        'order.hold',
        'config.risk',
      ],
    },
    ids: ['users', 'config', 'risk', 'reports', 'audit-logs'],
    groups: ['用户与订单', '规则与配置', '风控与 AI', '数据', '系统'],
  },
  {
    name: '财务小狸',
    snapshot: {
      isSuper: false,
      permissions: [
        'user.lookup',
        'fund.view',
        'export',
        'switch.payout',
        'withdraw.review',
        'payout.execute',
        'payout.manual_entry',
        'settle.bill',
        'settle.statement_upload',
        'fund.adjust',
        'fund.settle_adjust',
        'fund.recon',
        'fund.cash_entry',
      ],
    },
    ids: [
      'users',
      'withdrawals',
      'settle-bills',
      'ledger',
      'fund-ledger',
      'recon',
      'adjustments',
      'switches',
      'reports',
      'audit-logs',
    ],
    groups: ['用户与订单', '资金', '规则与配置', '数据', '系统'],
  },
  {
    name: '查询小狸',
    snapshot: { isSuper: false, permissions: ['user.lookup', 'order.view'] },
    ids: ['users', 'orders', 'reports', 'audit-logs'],
    groups: ['用户与订单', '数据', '系统'],
  },
  {
    name: '客服小狸',
    snapshot: { isSuper: false, permissions: [] },
    ids: ['reports', 'audit-logs'],
    groups: ['数据', '系统'],
  },
];

export const NO_PERMISSION_COPY = {
  welcome: '欢迎使用凑狸管理后台',
  title: '还没有分配权限',
  description:
    '账号 cs.xiaoli 已经可以登录，但超级管理员还没有给它勾选任何权限点，所以左侧菜单里没有业务页面。请联系超管在「后台账号与权限」为你勾选需要的权限点，勾选后刷新本页即可看到对应菜单。',
};

export function labels(ids: readonly string[]): string[] {
  return ids.map((id) => MENU.find((row) => row[1] === id)![2]);
}
