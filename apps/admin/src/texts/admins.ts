// Admin accounts list copy (design-hifi AdmAdmins; 08 has no admin.admins.* keys yet).
// Admin copy stays here, not in contracts/texts.default.json (规划/03 §9).
export const adminsTexts = {
  title: '后台账号与权限',
  note: '本页只有超级管理员可见。新建、停用账号和勾选、撤销权限点，每次都需要二次验证，并记入操作日志。',
  columns: {
    username: '账号',
    type: '类型',
    permissions: '权限点',
    totp: '动态码',
    verifyPhone: '验证手机号',
    status: '状态',
    createdAt: '创建时间',
  },
  type: { super: '超级管理员', ordinary: '普通账号' },
  permissionsAll: '全部',
  permissionCount: (count: number): string => `${count} 项`,
  totp: { bound: '已绑定', unbound: '未绑定' },
  verifyPhoneMissing: '未登记',
  status: { active: '启用', disabled: '已停用' },
  lockedUntil: (time: string): string => `已锁定 至 ${time}`,
  total: (total: number): string => `共 ${total} 条`,
  empty: '暂无后台账号',
  loadFailedTitle: '账号列表加载失败',
  loadFailedDescription: '暂时取不到后台账号列表，请稍后重试。',
  retry: '重试',
  forbiddenTitle: '无权限查看',
  forbiddenDescription: '当前账号没有查看后台账号的权限，本页只有超级管理员可见。',
} as const;
