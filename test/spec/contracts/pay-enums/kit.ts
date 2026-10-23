import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect } from 'vitest';

type Obj = Record<string, unknown>;
const root = new URL('../../../../', import.meta.url);
const testRequire = createRequire(import.meta.url);
const { parseYamlLite } = testRequire('../../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};

// 独立预期来自 SPEC_REF 的 04 §2.4 与任务书摘录的 BR-PAY-01/02/06/07。
// 不从契约或生成器推导预期；数组顺序即线上枚举顺序。
export const payValues = {
  pay_channel: ['wechat_pay', 'alipay'],
  pay_order_status: ['PENDING', 'PAID', 'CLOSED'],
  pay_refund_status: ['PROCESSING', 'SUCCESS', 'FAILED'],
  pay_ledger_type: ['PAY_RECEIPT', 'PAY_REFUND', 'PAY_ANOMALY', 'PAY_FEE'],
  pay_refund_reason: [
    'USER_REQUEST',
    'DUPLICATE_PAYMENT',
    'ANOMALY_RECEIPT',
    'RECON_DIFF',
    'OTHER',
  ],
  pay_refund_target_type: ['pay_order', 'pay_anomaly'],
  pay_query_attempt_kind: ['query', 'close', 'refund', 'refund_query'],
  pay_unavailable_reason: [
    'pay_disabled',
    'channel_disabled',
    'platform_not_allowed',
    'biz_not_sellable',
  ],
};

export function read(path: string): string {
  const file = new URL(path, root);
  // pay.yaml 尚未实现时，在测试体内断言失败，不能让 ENOENT 冒充先红。
  expect(existsSync(file), `缺少契约文件 ${path}`).toBe(true);
  return readFileSync(file, 'utf8');
}

export function object(value: unknown): Obj {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as Obj;
}

export function at(value: unknown, ...keys: string[]): Obj {
  let node = object(value);
  for (const key of keys) {
    expect(Object.hasOwn(node, key), `缺少字段 ${keys.join('.')}`).toBe(true);
    node = object(node[key]);
  }
  return node;
}

export function list(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}

export function yaml(path: string): Obj {
  return object(parseYamlLite(read(path)));
}

export function texts(path: string): Obj {
  return at(JSON.parse(read(path)), 'texts');
}
