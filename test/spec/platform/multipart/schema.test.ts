// F1-06s §9.2: multipart is metadata, never an Ajv body schema. Existing unsupported
// shapes stay refused; pair them with the new positive boundary for the first-red run.
import { expect, it } from 'vitest';
import {
  createValidatorCompiler,
  routeSchemaOf,
  type ContractOperation,
  type RouteSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { deepFreeze } from '../validation/kit.ts';

const multipartBody = deepFreeze({
  required: true,
  content: {
    'multipart/form-data': {
      schema: {
        type: 'object',
        required: ['file'],
        properties: { file: { type: 'string', format: 'binary' } },
      },
    },
  },
});

it('[AC-F1-06s#1] 必填且仅 multipart 的操作保留参数校验和 multipart 标记，不生成 body', () => {
  const operation = deepFreeze({
    operationId: 'uploadSchemaProbe',
    parameters: [
      {
        in: 'header',
        name: 'X-Upload-Token',
        required: true,
        schema: { type: 'string', minLength: 3 },
      },
      { in: 'query', name: 'version', required: true, schema: { type: 'integer', minimum: 1 } },
    ],
    requestBody: multipartBody,
  } satisfies ContractOperation);
  let schema: RouteSchema = {};
  expect(() => {
    schema = routeSchemaOf(operation, [
      { in: 'path', name: 'key', required: true, schema: { type: 'string', pattern: '^[a-z]+$' } },
    ]);
  }).not.toThrow();
  expect(schema.multipart).toBe(true);
  expect(schema).not.toHaveProperty('body');
  expect(schema).not.toHaveProperty('response');
  expect(schema).toMatchObject({
    params: { required: ['key'], additionalProperties: false },
    querystring: { required: ['version'], additionalProperties: false },
    headers: { required: ['x-upload-token'] },
  });
  const compiler = createValidatorCompiler();
  for (const [httpPart, valid, invalid] of [
    ['params', { key: 'brand' }, { key: '123' }],
    ['querystring', { version: '2' }, { version: '0' }],
    ['headers', { 'x-upload-token': 'abc', 'content-type': 'multipart/form-data' }, {}],
  ] as const) {
    const part = schema[httpPart];
    expect(part).toBeDefined();
    const validate = compiler({ schema: part ?? {}, httpPart });
    expect(validate({ ...valid }), httpPart).toBe(true);
    expect(validate({ ...invalid }), httpPart).toBe(false);
  }
});

it('[AC-F1-06s#2] 新增 multipart 支持不放行混合类型、可选体或表单编码，错误指出 operationId', () => {
  for (const [index, requestBody] of [
    { ...multipartBody, required: false },
    { content: multipartBody.content },
    {
      required: true,
      content: { ...multipartBody.content, 'application/json': { schema: { type: 'object' } } },
    },
    {
      required: true,
      content: { 'application/x-www-form-urlencoded': { schema: { type: 'object' } } },
    },
  ].entries()) {
    const operationId = `unsupportedUpload${index}`;
    expect(() => routeSchemaOf({ operationId, requestBody })).toThrow(operationId);
  }
  expect(
    routeSchemaOf({
      operationId: 'ordinaryJson',
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' } } },
      },
    }),
  ).toEqual({ body: { type: 'object' } });
  expect(() =>
    routeSchemaOf({ operationId: 'supportedUpload', requestBody: multipartBody }),
  ).not.toThrow();
});
