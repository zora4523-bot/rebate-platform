// Risk page copy (/risk; F1-10fa: the 规则清单 tab, contract CT-24f admin-risk). Admin copy stays
// here, not in contracts/texts.default.json (规划/03 §9). The names of a rule's status and hit
// action are read only from the console dictionary (BR-TEXT-25 admin_dict.risk_rule_status.*,
// admin_dict.risk_action.*); without a row the page shows the code, so none of them is written
// here. Which rules exist, their thresholds and versions always come from the server.
export const riskTexts = {
  title: '风控',
  tabs: {
    rules: '规则清单',
  },
  /** An account with risk.* but without config.risk: no tab of this page is open to it yet. */
  noTab: '当前账号没有可查看的风控页签。规则清单需要 config.risk 权限点，请联系超级管理员。',
  rules: {
    intro: '阈值在配置中心修改；点击阈值项进入配置中心对应配置项。启用或停用规则需二次验证。',
    count: (n: number): string => `共 ${n} 条规则`,
    dash: '—',
    columns: {
      rule: '规则',
      scene: '场景',
      action: '命中动作',
      status: '启停状态',
      thresholds: '关联阈值项',
      updated: '更新时间（北京时间）',
      operations: '操作',
    },
    enable: '启用',
    disable: '停用',
    loading: '正在加载规则清单…',
    empty: '暂无风控规则',
    loadFailedTitle: '规则清单加载失败',
    loadFailedDescription: '网络或服务暂时不可用，请重试。',
    retry: '重试',
    forbiddenTitle: '无权限查看规则清单',
    forbiddenDescription: '当前账号没有 config.risk 权限点，请联系超级管理员。',
    confirm: {
      title: (verb: string, name: string): string => `${verb}规则 · ${name}`,
      effect: (verb: string): string =>
        verb === '停用'
          ? '停用后该规则不再参与风控判断，直到重新启用。'
          : '启用后该规则重新参与风控判断。',
      rule: '规则',
      change: '状态变化',
      reasonLabel: '原因（选填）',
      reasonPlaceholder: '写明本次操作的原因，记入操作日志',
      reasonTooLong: (max: number): string => `原因不能超过 ${max} 字`,
      stepUpHint: '下一步需输入动态码完成二次验证。',
      cancel: '取消',
      submit: (verb: string): string => `确认${verb}`,
    },
    stepUpOperation: (verb: string, name: string): string => `${verb}规则「${name}」`,
    stepUpDetail: (id: string, from: string, to: string): string => `${id}：${from} → ${to}`,
    stepUpAgain: '动态码凭据已失效，请重新验证。',
    success: (verb: string, name: string): string => `已${verb}规则「${name}」`,
    errors: {
      conflict: '该规则已被他人修改，请刷新后重试（已重新读取列表）',
      missing: '该规则不存在或已被删除，已刷新列表',
      reason: '原因不符合要求（不能为空白，且不超过 200 字）',
      invalid: (verb: string): string => `${verb}失败：请求参数不正确`,
      forbidden: (verb: string): string => `无权限${verb}规则：当前账号没有 config.risk 权限点`,
      unknown: (verb: string): string =>
        `${verb}结果未确认（网络或服务异常），已重新读取列表，请以列表显示的状态为准`,
      failed: (verb: string): string => `${verb}失败，请稍后重试`,
    },
  },
} as const;
