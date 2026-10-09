import { expect, it } from 'vitest';
import { at, object, openapi, resolve, type Obj } from './kit.ts';

const methods = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

function checkHeader(doc: Obj, value: unknown, where: string): void {
  const response = resolve(doc, value);
  const headers = object(response['headers']);
  expect(headers, where).toHaveProperty('X-Trace-Id');
  const header = resolve(doc, headers['X-Trace-Id']);
  const parameter = resolve(doc, at(doc, 'components', 'parameters', 'TraceId'));
  expect(parameter['name']).toBe('X-Trace-Id');
  expect(resolve(doc, header['schema']), where).toEqual(resolve(doc, parameter['schema']));
}

it('[AC-CT-01e#1] 每个 operation 的所有成功与错误响应都声明同格式的 X-Trace-Id', () => {
  const doc = openapi();
  let count = 0;
  for (const [path, item] of Object.entries(at(doc, 'paths'))) {
    for (const method of methods) {
      const op = object(item)[method];
      if (op === undefined) continue;
      const responses = at(op, 'responses');
      expect(Object.keys(responses).length).toBeGreaterThan(0);
      for (const [status, response] of Object.entries(responses)) {
        checkHeader(doc, response, `${method.toUpperCase()} ${path} ${status}`);
        count++;
      }
    }
  }
  expect(count).toBeGreaterThan(0);
}, 30_000);

it('[AC-CT-01e#1] 所有共享响应组件也声明 X-Trace-Id，引用的头与 TraceId schema 一致', () => {
  const doc = openapi();
  const responses = at(doc, 'components', 'responses');
  expect(Object.keys(responses).length).toBeGreaterThan(0);
  for (const [name, response] of Object.entries(responses)) {
    checkHeader(doc, response, `components/responses/${name}`);
  }
}, 30_000);
