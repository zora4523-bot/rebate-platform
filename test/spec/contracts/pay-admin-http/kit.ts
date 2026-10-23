import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect } from 'vitest';

export type Obj = Record<string, unknown>;
type Validator = ((value: unknown) => boolean) & { errors?: unknown };
interface AjvInstance {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): Validator;
}
const root = new URL('../../../../', import.meta.url);
const require = createRequire(import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', root));
const { parseYamlLite } = require('../../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};
const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
  Ajv2020: new (options: { strict: true; allErrors: true }) => AjvInstance;
};
const addFormats = apiRequire('ajv-formats') as (ajv: AjvInstance) => void;

// 独立预期来自 CT-21e §9；不从待测 OpenAPI 推导路由或权限。
export const endpoints = [
  ['get', '/admin/v1/pay-orders', 'listAdminPayOrders', 'pay.view'],
  ['get', '/admin/v1/pay-orders/{pay_order_id}', 'getAdminPayOrder', 'pay.view'],
  ['post', '/admin/v1/pay-orders/{pay_order_id}/resolve', 'resolveAdminPayOrder', 'pay.resolve'],
  ['post', '/admin/v1/pay-orders/{pay_order_id}/refunds', 'createAdminPayRefund', 'pay.refund'],
  ['get', '/admin/v1/pay-refunds', 'listAdminPayRefunds', 'pay.view'],
  ['get', '/admin/v1/pay-refunds/{pay_refund_id}', 'getAdminPayRefund', 'pay.view'],
  ['get', '/admin/v1/pay-anomalies', 'listAdminPayAnomalies', 'pay.view'],
  [
    'post',
    '/admin/v1/pay-anomalies/{pay_anomaly_id}/refunds',
    'createAdminPayAnomalyRefund',
    'pay.refund',
  ],
  ['get', '/admin/v1/pay-recon-diffs', 'listAdminPayReconDiffs', 'pay.view'],
] as const;
export type Endpoint = readonly [
  method: 'get' | 'post',
  path: string,
  id: string,
  permission: string,
];
export const resolveEndpoint = endpoints[2];
export const refunds = [endpoints[3], endpoints[7]];
export const lists = [endpoints[0], endpoints[4], endpoints[6], endpoints[8]];
export const reasons = [
  'USER_REQUEST',
  'DUPLICATE_PAYMENT',
  'ANOMALY_RECEIPT',
  'RECON_DIFF',
  'OTHER',
];

export function read(path: string): string {
  return readFileSync(new URL(path, root), 'utf8');
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
    expect(node, `契约缺少 ${keys.join('.')}`).toHaveProperty(key);
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
export function contract(): Obj {
  return yaml('contracts/openapi.yaml');
}
export function operation(doc: Obj, endpoint: Endpoint): Obj {
  return at(doc, 'paths', endpoint[1], endpoint[0]);
}
export function resolve(doc: Obj, value: unknown): Obj {
  let node = object(value);
  const seen = new Set<string>();
  while (node['$ref'] !== undefined) {
    expect(node['$ref']).toBeTypeOf('string');
    const ref = node['$ref'] as string;
    expect(ref.startsWith('#/')).toBe(true);
    expect(seen.has(ref), `循环引用 ${ref}`).toBe(false);
    seen.add(ref);
    const { $ref: ignored, ...siblings } = node;
    void ignored;
    node = {
      ...at(
        doc,
        ...ref
          .slice(2)
          .split('/')
          .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~')),
      ),
      ...siblings,
    };
  }
  return node;
}
export function expand(doc: Obj, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((child) => expand(doc, child));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(resolve(doc, value)).map(([key, child]) => [key, expand(doc, child)]),
  );
}
export function parameters(doc: Obj, endpoint: Endpoint): Obj[] {
  const path = at(doc, 'paths', endpoint[1]);
  const op = operation(doc, endpoint);
  return [...list(path['parameters'] ?? []), ...list(op['parameters'] ?? [])].map((p) =>
    resolve(doc, p),
  );
}
export function request(doc: Obj, endpoint: Endpoint): Obj {
  const body = resolve(doc, at(operation(doc, endpoint), 'requestBody'));
  expect(body['required']).toBe(true);
  return resolve(doc, at(body, 'content', 'application/json', 'schema'));
}
export function response(doc: Obj, endpoint: Endpoint): Obj {
  return resolve(doc, at(operation(doc, endpoint), 'responses', '200'));
}
export function data(doc: Obj, endpoint: Endpoint): Obj {
  const schema = resolve(doc, at(response(doc, endpoint), 'content', 'application/json', 'schema'));
  expect(schema['required']).toEqual(expect.arrayContaining(['code', 'msg', 'data', 'trace_id']));
  return resolve(doc, at(schema, 'properties', 'data'));
}
export function prop(doc: Obj, schema: Obj, name: string): Obj {
  return resolve(doc, at(schema, 'properties', name));
}
export function required(schema: Obj, names: string[]): void {
  expect(Object.keys(at(schema, 'properties'))).toEqual(expect.arrayContaining(names));
  expect(schema['required']).toEqual(expect.arrayContaining(names));
}
export function values(schema: Obj): unknown[] {
  return Object.hasOwn(schema, 'const') ? [schema['const']] : list(schema['enum']);
}
export function compile(doc: Obj, schema: Obj): Validator {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (v) => Number.isInteger(v) && v >= -(2 ** 31) && v <= 2 ** 31 - 1,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  let validate: Validator | undefined;
  expect(() => {
    validate = ajv.compile(object(expand(doc, schema)));
  }, 'schema 必须通过 Ajv2020 strict 编译').not.toThrow();
  expect(validate).toBeTypeOf('function');
  return validate!;
}
export function check(validate: Validator, value: unknown, valid: boolean): void {
  expect(validate(value), JSON.stringify({ value, errors: validate.errors })).toBe(valid);
}
