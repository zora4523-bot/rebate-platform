import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';

// BR-TEXT-24: independent oracle, never derived from the implementation dictionary.
export const platforms = [
  { key: 'taobao', name: '淘宝', file: 'taobao' },
  { key: 'tmall', name: '天猫', file: 'tmall' },
  { key: 'jd', name: '京东', file: 'jd' },
  { key: 'pdd', name: '拼多多', file: 'pinduoduo' },
  { key: 'wechat', name: '微信', file: 'wechat' },
  { key: 'wechat_pay', name: '微信支付', file: 'wechat-pay' },
  { key: 'alipay', name: '支付宝', file: 'alipay' },
  { key: 'wecom', name: '企业微信', file: 'wecom' },
] as const satisfies readonly {
  key: keyof Schema<'ConfigPlatformIcons'>;
  name: string;
  file: string;
}[];

export function remoteIcon(
  url = 'https://media.example.test/platform/a.svg',
): Schema<'ConfigPlatformIcon'> {
  return { url, sha256: 'a'.repeat(64), version: 1 };
}
