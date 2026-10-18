import { expect, it } from 'vitest';
import {
  at,
  commonHeaders,
  contract,
  endpoints,
  list,
  object,
  operation,
  read,
  reasons,
  requiredCodes,
  resolve,
  text,
  yaml,
} from './kit.ts';

it.each(endpoints)(
  '[CT-04f#1] %s 的 %s 鉴权、签名、幂等和版本门禁完整',
  (method, id) => {
    const doc = contract();
    const op = operation(doc, method);
    expect(op['operationId']).toBe(id);
    expect(op['tags']).toEqual(['order']);
    expect(op['x-auth']).toBe('login');
    expect(op['security']).toEqual([{ bearerAuth: [] }]);
    expect(op['x-signed']).toBe(method === 'post');
    expect(op['x-idempotent']).toBe(method === 'post');
    expect([undefined, 'planned']).toContain(op['x-implementation']);
    expect(op).not.toHaveProperty('x-session-scopes');
    if (method === 'post') expect(op['x-min-version-gate']).toBe(true);
    else {
      expect(op).not.toHaveProperty('x-min-version-gate');
      expect(op['x-error-codes']).toEqual([]);
    }
    const refs = list(op['parameters']).map((param) => text(object(param)['$ref']));
    const names =
      method === 'post'
        ? [...commonHeaders, 'Timestamp', 'Nonce', 'Sign', 'IdempotencyKey']
        : [...commonHeaders, 'Cursor', 'Limit'];
    expect(refs.toSorted()).toEqual(
      names.map((name) => `#/components/parameters/${name}`).toSorted(),
    );
    if (method === 'post') {
      const params = list(op['parameters']).map((param) => resolve(doc, param));
      for (const name of ['X-Timestamp', 'X-Nonce', 'X-Sign', 'Idempotency-Key']) {
        expect(params).toContainEqual(
          expect.objectContaining({ name, in: 'header', required: true }),
        );
      }
    }
    const responses = at(op, 'responses');
    expect(responses).toHaveProperty('200');
    for (const value of Object.values(responses)) {
      const response = resolve(doc, value);
      const header = resolve(doc, at(response, 'headers', 'X-Trace-Id'));
      expect(resolve(doc, at(header, 'schema'))['type']).toBe('string');
    }
  },
);

it('[CT-04f#2] POST 使用已登记错误码，30202 / 30203 的 reason 复用原表全集', () => {
  const op = operation(contract(), 'post');
  const codes = list(op['x-error-codes']);
  expect(codes).toEqual(expect.arrayContaining(requiredCodes));
  const catalog = list(yaml('contracts/error-codes.yaml')['codes']).map(object);
  for (const code of codes) {
    expect(code).toBeTypeOf('number');
    const matches = catalog.filter((entry) => entry['code'] === code);
    expect(matches).toHaveLength(1);
    expect([undefined, false]).toContain(object(matches[0])['deprecated']);
  }
  for (const [code, expected] of Object.entries(reasons)) {
    const entry = catalog.find((candidate) => candidate['code'] === Number(code));
    expect(list(at(entry, 'data')['reason']).toSorted()).toEqual(expected.toSorted());
  }
});

it('[CT-04f#3] README 的 openapi 条目登记两个新增接口', () => {
  const line = read('contracts/README.md')
    .split('\n')
    .find((entry) => entry.startsWith('| `openapi.yaml` |'));
  expect(line).toContain('POST /v1/orders/claims');
  expect(line).toContain('GET /v1/orders/claims');
});
