import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export type Obj = Record<string, unknown>;
export type Validator = ((value: unknown) => boolean) & { errors?: unknown };
interface AjvInstance {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): Validator;
}

export const root = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', root));
export const testRequire = createRequire(import.meta.url);
const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
  Ajv2020: new (options: { strict: true; allErrors: true }) => AjvInstance;
};
const addFormats = apiRequire('ajv-formats') as (ajv: AjvInstance) => void;
const { dereference } = apiRequire('@readme/openapi-parser') as {
  dereference(path: string): Promise<unknown>;
};
export const { parseYamlLite } = testRequire('../../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};

export const endpoints = [
  ['post', '/v1/agent/sessions', 'createAgentSession'],
  ['get', '/v1/agent/sessions/current', 'getCurrentAgentSession'],
  ['post', '/v1/agent/sessions/{id}/messages', 'sendAgentMessage'],
  ['post', '/v1/agent/runs/{run_id}/cancel', 'cancelAgentRun'],
] as const;
export const sendPath = '/v1/agent/sessions/{id}/messages';
export const streamOperation = `POST ${sendPath}`;

// 缺接口、字段或例子先断言，避免 TypeError 被误计为先红。
export function object(value: unknown): Obj {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as Obj;
}

export function at(value: unknown, ...keys: string[]): Obj {
  let current = object(value);
  for (const key of keys) {
    expect(current, `缺少契约字段 ${keys.join('.')}`).toHaveProperty(key);
    current = object(current[key]);
  }
  return current;
}

export function list(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}

export function text(value: unknown): string {
  expect(value).toBeTypeOf('string');
  return value as string;
}

let document: Promise<unknown> | undefined;
export async function contract(): Promise<Obj> {
  document ??= dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)));
  return object(await document);
}

export function operation(doc: Obj, method: string, path: string): Obj {
  return at(doc, 'paths', path, method);
}

export function compile(schema: Obj): Validator {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  let validate: Validator | undefined;
  expect(() => {
    validate = ajv.compile(schema);
  }, '契约 schema 必须能由 Ajv2020 strict 编译').not.toThrow();
  expect(validate).toBeTypeOf('function');
  return validate!;
}

export function check(validate: Validator, value: unknown, expected: boolean): void {
  const actual = validate(value);
  expect(actual, JSON.stringify({ value, errors: validate.errors })).toBe(expected);
}

export function examples(media: Obj): unknown[] {
  const values: unknown[] = [];
  if (Object.hasOwn(media, 'example')) values.push(media['example']);
  if (Object.hasOwn(media, 'examples')) {
    for (const example of Object.values(object(media['examples']))) {
      const entry = object(example);
      expect(entry).toHaveProperty('value');
      values.push(entry['value']);
    }
  }
  expect(values.length, '至少一个内联示例').toBeGreaterThan(0);
  return values;
}

export function errorCodes(): Obj[] {
  const doc = object(
    parseYamlLite(readFileSync(new URL('contracts/error-codes.yaml', root), 'utf8')),
  );
  return list(doc['codes']).map(object);
}

export function liveCode(codes: Obj[], code: number): Obj {
  const matches = codes.filter((entry) => entry['code'] === code);
  expect(matches, `错误码 ${code} 必须唯一登记`).toHaveLength(1);
  const entry = object(matches[0]);
  expect([undefined, false]).toContain(entry['deprecated']);
  return entry;
}

export const session = {
  session_id: '019a0000-0000-7000-8000-000000000001',
  started_at: '2026-10-06T09:00:00+08:00',
  last_active_at: '2026-10-06T09:01:00+08:00',
};

export function envelope(data: unknown): Obj {
  return { code: 0, msg: '', data, trace_id: '019a0000-0000-7000-8000-000000000002' };
}
