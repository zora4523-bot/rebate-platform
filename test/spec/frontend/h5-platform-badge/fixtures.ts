import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';

// BR-TEXT-24: independent oracle, never derived from the implementation dictionary.
// ext: the owner's official images (couli design/icons/platform/, 2026-10-19) are PNG; the keys
// still waiting for one keep the neutral placeholder SVG (F1-06zk).
export const platforms = [
  { key: 'taobao', name: '淘宝', file: 'taobao', ext: 'png' },
  { key: 'tmall', name: '天猫', file: 'tmall', ext: 'svg' },
  { key: 'jd', name: '京东', file: 'jd', ext: 'png' },
  { key: 'pdd', name: '拼多多', file: 'pinduoduo', ext: 'png' },
  { key: 'wechat', name: '微信', file: 'wechat', ext: 'svg' },
  { key: 'wechat_pay', name: '微信支付', file: 'wechat-pay', ext: 'svg' },
  { key: 'alipay', name: '支付宝', file: 'alipay', ext: 'svg' },
  { key: 'wecom', name: '企业微信', file: 'wecom', ext: 'svg' },
] as const satisfies readonly {
  key: keyof Schema<'ConfigPlatformIcons'>;
  name: string;
  file: string;
  ext: 'png' | 'svg';
}[];

/** The extension of the built-in file `file` (a file name of the table above). */
export function builtinExt(file: string): 'png' | 'svg' {
  const platform = platforms.find((candidate) => candidate.file === file);
  if (platform === undefined) throw new Error(`no built-in file named ${file}`);
  return platform.ext;
}

export function remoteIcon(
  url = 'https://media.example.test/platform/a.svg',
): Schema<'ConfigPlatformIcon'> {
  return { url, sha256: 'a'.repeat(64), version: 1 };
}
