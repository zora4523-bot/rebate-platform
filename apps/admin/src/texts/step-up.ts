// Step-up verification copy (design-hifi AdmStepUp, AdmStepUpSms; 规划/03 §9.2). Error lines follow
// BR-TEXT-14 table B; `generic` has no 08 key yet (agent default, F1-frontend/needs.md).
export const stepUpTexts = {
  totp: {
    title: '二次验证 · 动态码',
    label: '动态码',
    hint: '请输入身份验证器中的 6 位动态码',
  },
  sms: {
    title: '二次验证 · 短信',
    label: '验证码',
    hint: '请输入短信中的 6 位验证码；短信发到本后台账号登记的验证手机号',
  },
  operationPrefix: '本次操作：',
  smsExplanation: '这一类操作会改动账户余额，需要短信验证；本次验证会记入操作日志。',
  smsSentTo: '验证码已发送至 ',
  resend: '重新发送',
  resendCountdown: (seconds: number): string => `重新发送（${seconds} 秒）`,
  close: '关闭',
  cancel: '取消',
  submit: '验证并继续',
  errors: {
    incorrect: '验证码错误，请重新输入',
    expired: '验证码已失效，请重新获取',
    frequent: '操作太频繁，请稍后再试',
    generic: '验证失败，请稍后重试',
  },
  // BR-TEXT-14 table B error.10003.verify_phone_missing.
  verifyPhoneMissing: '这项操作需要短信验证，请先登记验证手机号',
} as const;
