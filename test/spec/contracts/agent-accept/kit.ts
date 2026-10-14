import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export type Obj = Record<string, unknown>;
type Validator = ((value: unknown) => boolean) & { errors?: unknown };
interface AjvInstance {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): Validator;
}

const root = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', root));
const testRequire = createRequire(import.meta.url);
const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
  Ajv2020: new (options: { strict: true; allErrors: true }) => AjvInstance;
};
const addFormats = apiRequire('ajv-formats') as (ajv: AjvInstance) => void;
const { dereference } = apiRequire('@readme/openapi-parser') as {
  dereference(path: string): Promise<unknown>;
};
const { parseYamlLite } = testRequire('../../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};

// 先断言再访问，字段缺失必须报断言失败，不能以 TypeError 冒充先红。
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

export function liveCode(code: number): Obj {
  const doc = object(
    parseYamlLite(readFileSync(new URL('contracts/error-codes.yaml', root), 'utf8')),
  );
  const matches = list(doc['codes'])
    .map(object)
    .filter((entry) => entry['code'] === code);
  expect(matches, `错误码 ${code} 必须唯一登记`).toHaveLength(1);
  const entry = object(matches[0]);
  expect([undefined, false]).toContain(entry['deprecated']);
  return entry;
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
  }, 'schema 必须能由 Ajv2020 strict 编译').not.toThrow();
  expect(validate).toBeTypeOf('function');
  return validate!;
}

export function check(validate: Validator, value: unknown, expected: boolean): void {
  expect(validate(value), JSON.stringify({ value, errors: validate.errors })).toBe(expected);
}

// 只忽略说明文字，保留全部结构字段；不使用待测组件自身作为期望值。
export function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'description')
      .map(([key, item]) => [key, shape(item)]),
  );
}
