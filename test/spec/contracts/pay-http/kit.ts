import { expect } from 'vitest';
import { at, compile as compileJsonSchema, list, object, type Obj } from '../agent-http/kit.ts';

export {
  at,
  check,
  contract,
  envelope,
  errorCodes,
  list,
  liveCode,
  object,
  operation,
  root,
  testRequire,
  text,
  type Obj,
} from '../agent-http/kit.ts';

export const endpoints = [
  ['post', '/v1/pay/orders', 'createPayOrder'],
  ['get', '/v1/pay/orders/{pay_order_id}', 'getPayOrder'],
  ['post', '/v1/pay/orders/{pay_order_id}/returned', 'payOrderReturned'],
  ['post', '/v1/pay/orders/{pay_order_id}/cancel', 'cancelPayOrder'],
] as const;

// 这些是 schema 验证用的合成值，不代表已登记业务或真实渠道报文。
export const order = {
  pay_order_id: '019a0000-0000-7000-8000-000000000001',
  biz_type: 'contract_fixture',
  biz_ref: '019a0000-0000-7000-8000-000000000002',
  pay_channel: 'wechat_pay',
  amount_fen: 101,
  refunded_fen: 0,
  status: 'PENDING',
  expire_at: '2026-10-22T09:15:00+08:00',
  paid_at: null,
  closed_at: null,
  created_at: '2026-10-22T09:00:00+08:00',
};

export const launchSamples: Record<string, Obj> = {
  wechat_pay: {
    appid: 'contract-fixture-app',
    partnerid: 'contract-fixture-merchant',
    prepayid: 'contract-fixture-prepay',
    package: 'Sign=WXPay',
    noncestr: 'contract-fixture-nonce',
    timestamp: '1792630800',
    sign: 'contract-fixture-signature',
  },
  alipay: { order_str: 'contract-fixture-order-string' },
};

// OAS 扩展不是 JSON Schema 关键字；单独断言 x-no-log 后，仅在 Ajv 输入中去掉注释。
function validationSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(validationSchema);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith('x-') && key !== 'discriminator')
      .map(([key, child]) => [key, validationSchema(child)]),
  );
}

export function compile(schema: Obj) {
  return compileJsonSchema(object(validationSchema(schema)));
}

export function responseSchema(op: Obj): Obj {
  return at(op, 'responses', '200', 'content', 'application/json', 'schema');
}

// 允许 schema 用 allOf 复用 PayOrder；不依赖响应 schema 的命名。
export function property(schema: Obj, name: string): Obj {
  const direct = object(schema['properties'] ?? {})[name];
  if (direct !== undefined) return object(direct);
  const matches = list(schema['allOf'] ?? [])
    .map(object)
    .filter((part) => Object.hasOwn(object(part['properties'] ?? {}), name));
  expect(matches, `schema 缺少属性 ${name}`).toHaveLength(1);
  return at(matches[0], 'properties', name);
}

export function descriptions(value: unknown): string {
  if (Array.isArray(value)) return value.map(descriptions).join(' ');
  if (value === null || typeof value !== 'object') return '';
  return Object.entries(value)
    .map(([key, child]) =>
      key === 'description' && typeof child === 'string' ? child : descriptions(child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}
