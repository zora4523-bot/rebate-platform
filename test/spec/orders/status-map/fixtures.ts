import { readFileSync } from 'node:fs';
import { expect } from 'vitest';

export const HEADER = 'raw_code,event,source,verified,note';

// 合成码仅供测试，不代表任何真实平台报文或实测结论，不依赖演示平台或资产。
export const SYNTHETIC_CSV = `${HEADER}
x-deposit,PLATFORM_DEPOSIT_PAID,synthetic,false,合成定金
x-paid,PLATFORM_PAID,synthetic,false,合成付款
x-received,PLATFORM_RECEIVED,synthetic,false,合成收货
x-settled,PLATFORM_SETTLED,synthetic,false,合成结算
x-invalid,PLATFORM_INVALID,synthetic,false,合成失效
x-punish,PLATFORM_PUNISH,synthetic,false,合成处罚
x-rights,PLATFORM_RIGHTS,synthetic,false,合成维权
`;

export function readStatusCsv(platform: 'pdd' | 'taobao' | 'jd'): string | null {
  try {
    return readFileSync(
      new URL(`../../../../specs/order-status-map/${platform}.csv`, import.meta.url),
      'utf8',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function requiredStatusCsv(platform: 'pdd'): string {
  const text = readStatusCsv(platform);
  // 缺少实现资产时是断言失败，不让 ENOENT 作为先红原因。
  expect(text, `specs/order-status-map/${platform}.csv 必须存在`).not.toBeNull();
  return text!;
}
