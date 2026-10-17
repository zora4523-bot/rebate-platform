import { readFileSync } from 'node:fs';
import { expect } from 'vitest';

export const HEADER = 'raw_code,event,source,verified,note';

// 演示码仅供测试，不代表任何真实平台报文或实测结论。
export const DEMO_CSV = `${HEADER}
demo-deposit,PLATFORM_DEPOSIT_PAID,demo,false,演示定金
demo-paid,PLATFORM_PAID,demo,false,演示付款
demo-received,PLATFORM_RECEIVED,demo,false,演示收货
demo-settled,PLATFORM_SETTLED,demo,false,演示结算
demo-invalid,PLATFORM_INVALID,demo,false,演示失效
demo-punish,PLATFORM_PUNISH,demo,false,演示处罚
demo-rights,PLATFORM_RIGHTS,demo,false,演示维权
`;

export function readStatusCsv(platform: 'demo' | 'pdd' | 'taobao' | 'jd'): string | null {
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

export function requiredStatusCsv(platform: 'demo' | 'pdd'): string {
  const text = readStatusCsv(platform);
  // 缺少实现资产时是断言失败，不让 ENOENT 作为先红原因。
  expect(text, `specs/order-status-map/${platform}.csv 必须存在`).not.toBeNull();
  return text!;
}
