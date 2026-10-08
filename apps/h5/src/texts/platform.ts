import type { Schema } from '@couli/contracts-ts';

// Platform names for source badges (08 BR-TEXT-24 table). 08 has no separate text keys for
// them yet; the orchestrator registers that gap. Screen readers always read these names.
const platformNames: Readonly<Record<keyof Schema<'ConfigPlatformIcons'>, string>> = {
  taobao: '淘宝',
  tmall: '天猫',
  jd: '京东',
  pdd: '拼多多',
  wechat: '微信',
  wechat_pay: '微信支付',
  alipay: '支付宝',
  wecom: '企业微信',
};

export function getPlatformName(platform: keyof Schema<'ConfigPlatformIcons'>): string {
  return platformNames[platform];
}
