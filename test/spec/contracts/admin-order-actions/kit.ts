import { expect } from 'vitest';
import {
  at,
  check,
  compile,
  expand,
  list,
  object,
  resolve,
  text,
  type Obj,
} from '../order-claims/kit.ts';

export {
  at,
  check,
  compile,
  contract,
  expand,
  list,
  object,
  read,
  resolve,
  text,
  yaml,
} from '../order-claims/kit.ts';
export type { Obj } from '../order-claims/kit.ts';

// 独立预期来自 CT-24n 任务书 04 §6.6 / §11.2 与 K-4/6/7/9；不从实现生成。
export const routes = [
  ['post', '/admin/v1/order-syncs', 'adminCreateOrderSync', 'order.view'],
  ['get', '/admin/v1/order-syncs', 'adminListOrderSyncs', 'order.view'],
  ['get', '/admin/v1/order-syncs/limits', 'adminGetOrderSyncLimits', 'order.view'],
  ['post', '/admin/v1/rights-imports', 'adminCreateRightsImport', 'order.claim'],
  ['get', '/admin/v1/rights-imports', 'adminListRightsImports', 'order.claim'],
  ['get', '/admin/v1/rights-imports/{import_id}', 'adminGetRightsImport', 'order.claim'],
  ['post', '/admin/v1/orders/{order_id}/hold', 'adminHoldOrder', 'order.hold'],
  ['post', '/admin/v1/orders/{order_id}/unhold', 'adminUnholdOrder', 'order.hold'],
  ['post', '/admin/v1/orders/{order_id}/reassign', 'adminReassignOrder', 'order.assign'],
] as const;
export const syncPath = '/admin/v1/order-syncs';
export const importPath = '/admin/v1/rights-imports';
export const orderPath = '/admin/v1/orders/{order_id}';
export const id = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a01';
export const from = '2026-10-21T00:00:00+08:00';
export const to = '2026-10-22T00:00:00+08:00';
export const statuses = ['queued', 'running', 'done', 'failed'];
export const failureReasons = [
  'invalid_row',
  'order_not_found',
  'sub_order_no_missing',
  'received_at_missing',
  'platform_mismatch',
];

export function op(doc: Obj, path: string, method = 'post'): Obj {
  // 所有新接口缺失均先断言失败，禁止 undefined 属性访问导致 TypeError 假红。
  return at(doc, 'paths', path, method);
}
export function params(doc: Obj, path: string, method = 'post'): Obj[] {
  const pathItem = at(doc, 'paths', path);
  const operation = op(doc, path, method);
  return [...list(pathItem['parameters'] ?? []), ...list(operation['parameters'] ?? [])].map(
    (value) => resolve(doc, value),
  );
}
export function body(doc: Obj, path: string, multipart = false): Obj {
  const request = resolve(doc, at(op(doc, path), 'requestBody'));
  expect(request['required']).toBe(true);
  return resolve(
    doc,
    at(request, 'content', multipart ? 'multipart/form-data' : 'application/json', 'schema'),
  );
}
export function response(doc: Obj, path: string, method = 'post'): Obj {
  const result = resolve(doc, at(op(doc, path, method), 'responses', '200'));
  return resolve(doc, at(result, 'content', 'application/json', 'schema'));
}
export function data(doc: Obj, path: string, method = 'post'): Obj {
  return resolve(doc, at(response(doc, path, method), 'properties', 'data'));
}
export function item(doc: Obj, path: string): Obj {
  return resolve(doc, at(data(doc, path, 'get'), 'properties', 'items', 'items'));
}
export function field(doc: Obj, schema: Obj, name: string): Obj {
  return resolve(doc, at(schema, 'properties', name));
}
// 请求可用 oneOf、anyOf 或 allOf；检查字段存在时不钉死组件名或分支书写方式。
export function propertiesIn(doc: Obj, schema: Obj, name: string): Obj[] {
  const value = resolve(doc, schema);
  const properties = object(value['properties'] ?? {});
  const direct = properties[name] === undefined ? [] : [resolve(doc, properties[name])];
  return [
    ...direct,
    ...['oneOf', 'anyOf', 'allOf'].flatMap((keyword) =>
      list(value[keyword] ?? []).flatMap((branch) => propertiesIn(doc, object(branch), name)),
    ),
  ];
}
export function required(schema: Obj, keys: string[]): void {
  expect(list(schema['required'])).toEqual(expect.arrayContaining(keys));
  for (const key of keys) expect(at(schema, 'properties')).toHaveProperty(key);
}
export function without(value: Obj, key: string): Obj {
  const result = { ...value };
  delete result[key];
  return result;
}
export function missingRejected(doc: Obj, schema: Obj, value: Obj, keys: string[]): void {
  const validate = compile(doc, schema);
  check(validate, value, true);
  for (const key of keys) check(validate, without(value, key), false);
}
export function accepts(doc: Obj, schema: Obj, valid: unknown[], invalid: unknown[]): void {
  const validate = compile(doc, schema);
  for (const value of valid) check(validate, value, true);
  for (const value of invalid) check(validate, value, false);
}
export function enumField(
  doc: Obj,
  schema: Obj,
  name: string,
  values: string[],
  nullable = false,
): void {
  const property = field(doc, schema, name);
  function declared(value: Obj): string[] {
    const resolved = resolve(doc, value);
    const direct = list(resolved['enum'] ?? []).filter(
      (entry): entry is string => typeof entry === 'string',
    );
    if (typeof resolved['const'] === 'string') direct.push(resolved['const']);
    return [
      ...direct,
      ...list(resolved['anyOf'] ?? resolved['oneOf'] ?? []).flatMap((branch) =>
        declared(object(branch)),
      ),
    ];
  }
  expect([...new Set(declared(property))].toSorted()).toEqual(values.toSorted());
  accepts(
    doc,
    property,
    [...values, ...(nullable ? [null] : [])],
    ['', 'unknown', 1, {}, [], ...(nullable ? [] : [null])],
  );
}
export function description(doc: Obj, path: string, method = 'post'): string {
  return text(op(doc, path, method)['description']);
}
export function errorExamples(doc: Obj, path: string, method = 'post', httpStatus?: string): Obj[] {
  const result: Obj[] = [];
  for (const [status, raw] of Object.entries(at(op(doc, path, method), 'responses'))) {
    if (!/^[45]/.test(status)) continue;
    if (httpStatus !== undefined && status !== httpStatus) continue;
    const media = at(resolve(doc, raw), 'content', 'application/json');
    if (media['example'] !== undefined) result.push(object(media['example']));
    for (const example of Object.values(object(media['examples'] ?? {}))) {
      result.push(at(resolve(doc, example), 'value'));
    }
  }
  return result;
}
export function errorWith(doc: Obj, path: string, code: number, expectedData: Obj): void {
  expect(errorExamples(doc, path)).toContainEqual(
    expect.objectContaining({
      code,
      data: expect.objectContaining(expectedData),
    }),
  );
}
export function multipartSchema(doc: Obj): Obj {
  const schema = object(expand(doc, body(doc, importPath, true)));
  // binary 是 OpenAPI 传输标注，不是 ajv-formats 的 JSON 格式。先独立核验，再仅擦除
  // 该标注检查 multipart parts 的结构；不宣称能用 JSON Schema 验证 Excel 内容。
  function stripBinary(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripBinary);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, child]) => !(key === 'format' && child === 'binary'))
        .map(([key, child]) => [key, stripBinary(child)]),
    );
  }
  expect(JSON.stringify(schema)).toContain('"format":"binary"');
  return object(stripBinary(schema));
}
