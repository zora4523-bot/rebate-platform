import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect } from 'vitest';

export type Obj = Record<string, unknown>;
export const root = new URL('../../../../', import.meta.url);
export const testRequire = createRequire(import.meta.url);
export const { parseYamlLite } = testRequire('../../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};
export const streamPath = '/v1/agent/sessions/{id}/messages';
export const streamOperation = `POST ${streamPath}`;

export function read(relative: string): string {
  return readFileSync(new URL(relative, root), 'utf8');
}

// 先断言形状，缺字段只产生断言失败，不让 TypeError 冒充先红。
export function object(value: unknown): Obj {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as Obj;
}

export function at(value: unknown, ...keys: string[]): Obj {
  let current = object(value);
  for (const key of keys) current = object(current[key]);
  return current;
}

export function text(value: unknown): string {
  expect(value).toBeTypeOf('string');
  return value as string;
}

export function openapi(): Obj {
  return object(parseYamlLite(read('contracts/openapi.yaml')));
}

// 仅解析正在检查的 Response / Header / Schema 引用，避免递归展开整份契约。
export function resolve(doc: Obj, value: unknown): Obj {
  let node = object(value);
  const seen = new Set<string>();
  while (node['$ref'] !== undefined) {
    const ref = text(node['$ref']);
    expect(ref.startsWith('#/'), '本任务的契约引用必须在当前文档内').toBe(true);
    expect(seen.has(ref), `循环引用 ${ref}`).toBe(false);
    seen.add(ref);
    const keys = ref
      .slice(2)
      .split('/')
      .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'));
    node = at(doc, ...keys);
  }
  return node;
}

// yaml-lite 支持的子集；字符串使用 JSON 双引号转义，保留 SSE 尾部换行。
export function yaml(value: unknown, depth = 0): string {
  const indent = '  '.repeat(depth);
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item) => ['-', item])
    : Object.entries(object(value)).map(([key, item]) => [`${JSON.stringify(key)}:`, item]);
  return entries
    .map(([key, item]) => {
      if (item !== null && typeof item === 'object' && Object.keys(item).length > 0) {
        const nested = yaml(item, depth + 1);
        return key === '-'
          ? `${indent}- ${nested.slice(indent.length + 2)}`
          : `${indent}${key}\n${nested}`;
      }
      return `${indent}${key} ${JSON.stringify(item)}\n`;
    })
    .join('');
}
