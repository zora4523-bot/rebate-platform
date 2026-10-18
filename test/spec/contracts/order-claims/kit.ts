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
const testRequire = createRequire(import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', root));
const { parseYamlLite } = testRequire('../../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};
const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
  Ajv2020: new (options: { strict: true; allErrors: true }) => AjvInstance;
};
const addFormats = apiRequire('ajv-formats') as (ajv: AjvInstance) => void;

// CT-04f 编排补充的独立预期；不从被测契约生成期望值。
export const claimPath = '/v1/orders/claims';
export const endpoints = [
  ['post', 'createOrderClaim'],
  ['get', 'listOrderClaims'],
] as const;
export const commonHeaders = [
  'AppId',
  'Platform',
  'AppVersion',
  'Build',
  'Channel',
  'TraceId',
  'DeviceId',
];
export const claimKeys = [
  'claim_id',
  'platform',
  'order_no',
  'paid_date',
  'status',
  'created_at',
  'items',
];
export const itemKeys = ['sub_order_id', 'decision', 'reject_reason'];
export const enumValues = {
  claim_status: ['submitted', 'auto_matched', 'manual_review', 'approved', 'rejected', 'cancelled'],
  claim_item_decision: ['approved', 'rejected', 'cancelled'],
  claim_reject_reason: [
    'NO_EVIDENCE',
    'EXPIRED_CLICK',
    'NOT_TRACKED',
    'OTHER_TLJ',
    'FRAUD',
    'OTHER',
    'NOT_IN_POOL',
    'ORDER_INVALID',
  ],
};
export const requiredCodes = [30201, 30202, 30203, 30204, 30205, 30206, 10405];
export const reasons = {
  '30202': ['FACTOR_MISMATCH', 'CLAIM_EXPIRED', 'ORDER_INVALID', 'ALREADY_YOURS'],
  '30203': ['RISK_BLOCKED'],
};
export const request = { platform: 'pdd', order_no: '231006-1234567890', paid_date: '2026-10-06' };
export const item = { sub_order_id: '231006-1234567890', decision: null, reject_reason: null };
export const claim = {
  claim_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a62',
  ...request,
  status: 'manual_review',
  created_at: '2026-10-06T12:00:00+08:00',
  items: [item],
};

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
    expect(node, `缺少 ${keys.join('.')}`).toHaveProperty(key);
    node = object(node[key]);
  }
  return node;
}
export function list(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}
export function text(value: unknown): string {
  expect(value).toBeTypeOf('string');
  return value as string;
}
export function yaml(path: string): Obj {
  return object(parseYamlLite(read(path)));
}
export function contract(): Obj {
  return yaml('contracts/openapi.yaml');
}
export function operation(doc: Obj, method: string): Obj {
  return at(doc, 'paths', claimPath, method);
}
export function resolve(doc: Obj, value: unknown): Obj {
  let node = object(value);
  const seen = new Set<string>();
  while (node['$ref'] !== undefined) {
    const ref = text(node['$ref']);
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
// 只展开所测 schema；不执行生成代码，不连接接口或数据库。
export function expand(doc: Obj, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => expand(doc, entry));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(resolve(doc, value)).map(([key, child]) => [key, expand(doc, child)]),
  );
}
export function media(doc: Obj, method: string): Obj {
  const response = resolve(doc, at(operation(doc, method), 'responses', '200'));
  return at(response, 'content', 'application/json');
}
export function responseSchema(doc: Obj, method: string): Obj {
  return resolve(doc, at(media(doc, method), 'schema'));
}
export function dataSchema(doc: Obj, method: string): Obj {
  return resolve(doc, at(responseSchema(doc, method), 'properties', 'data'));
}
export function claimSchema(doc: Obj, method: string): Obj {
  const data = dataSchema(doc, method);
  return method === 'post' ? data : resolve(doc, at(data, 'properties', 'items', 'items'));
}
export function itemSchema(doc: Obj, method: string): Obj {
  return resolve(doc, at(claimSchema(doc, method), 'properties', 'items', 'items'));
}
export function requestSchema(doc: Obj): Obj {
  const body = resolve(doc, at(operation(doc, 'post'), 'requestBody'));
  expect(body['required']).toBe(true);
  return resolve(doc, at(body, 'content', 'application/json', 'schema'));
}
export function closed(schema: Obj, keys: string[]): void {
  expect(schema['type']).toBe('object');
  expect(schema['additionalProperties']).toBe(false);
  expect(Object.keys(at(schema, 'properties')).toSorted()).toEqual(keys.toSorted());
  expect(list(schema['required']).toSorted()).toEqual(keys.toSorted());
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
  }, 'Ajv2020 strict 编译').not.toThrow();
  expect(validate).toBeTypeOf('function');
  return validate!;
}
export function check(validate: Validator, value: unknown, valid: boolean): void {
  expect(validate(value), JSON.stringify({ value, errors: validate.errors })).toBe(valid);
}
export function examples(doc: Obj, value: Obj): unknown[] {
  const result: unknown[] = [];
  if (Object.hasOwn(value, 'example')) result.push(value['example']);
  if (value['examples'] !== undefined) {
    for (const entry of Object.values(object(value['examples']))) {
      const example = resolve(doc, entry);
      expect(example).toHaveProperty('value');
      result.push(example['value']);
    }
  }
  expect(result.length, '至少一个响应示例').toBeGreaterThan(0);
  return result;
}
export function envelope(data: unknown): Obj {
  return { code: 0, msg: '', data, trace_id: 'ct-04f-synthetic' };
}
