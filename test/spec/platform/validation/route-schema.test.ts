// Rule tests for routeSchemaOf (ADR-0001 §4.2 第 15 项: route schemas come from contracts/, header
// parameter names are lower-cased, never a `response` part; contract in
// apps/api/src/modules/platform/validation/index.ts). Expected schemas are written out by hand.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  routeSchemaOf,
  type ContractOperation,
  type ContractParameter,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { APP_ID, BODY_SCHEMA, LIMIT_PATH_ITEM, PRODUCT_ID, sampleOperation } from './kit.ts';

const TRACE_PATH_ITEM: ContractParameter = {
  name: 'X-Trace-Id',
  in: 'header',
  required: true,
  schema: { type: 'string' },
};

it('[ADR-0001 §4.2 #15] 由契约操作生成 params、querystring、headers（参数名转小写）与 body 四部分；操作级参数替换路径级同名参数', () => {
  const operation = sampleOperation();
  const traceOverride: ContractParameter = {
    name: 'x-trace-id',
    in: 'header',
    required: false,
    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
  };
  const schema = routeSchemaOf(
    { ...operation, parameters: [...(operation.parameters ?? []), traceOverride] },
    [APP_ID, LIMIT_PATH_ITEM, TRACE_PATH_ITEM],
  );
  expect(schema).toEqual({
    params: {
      type: 'object',
      properties: { product_id: PRODUCT_ID.schema },
      required: ['product_id'],
      additionalProperties: false,
    },
    querystring: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        cursor: { type: 'string', minLength: 1 },
      },
      required: ['cursor'],
      additionalProperties: false,
    },
    headers: {
      type: 'object',
      properties: {
        'x-app-id': APP_ID.schema,
        'x-trace-id': { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
        'x-device-id': { type: 'string' },
        'idempotency-key': { type: 'string', minLength: 8 },
      },
      required: ['x-app-id', 'x-device-id'],
    },
    body: BODY_SCHEMA,
  });
  expect(Object.keys(schema)).not.toContain('response');
});

it('[ADR-0001 §4.2 #15] 没有参数与请求体的操作得到空的路由 schema；无论操作写了什么响应，结果里都没有 response', () => {
  const healthz: ContractOperation = {
    operationId: 'getHealthz',
    responses: {
      '200': {
        description: 'ok',
        content: {
          'application/json': {
            schema: { type: 'object', additionalProperties: false, properties: {} },
          },
        },
      },
    },
  };
  expect(routeSchemaOf(healthz)).toEqual({});
  expect(routeSchemaOf({ ...healthz, parameters: [] }, [])).toEqual({});
  expect(Object.keys(routeSchemaOf(sampleOperation(), [APP_ID]))).not.toContain('response');
});

it('[ADR-0001 §4.2 #15] 只有路径级参数时同样生成；路径参数一律必填、查询参数不认识的键被拒（additionalProperties: false）', () => {
  const operation: ContractOperation = { operationId: 'getThing' };
  expect(routeSchemaOf(operation, [PRODUCT_ID, LIMIT_PATH_ITEM])).toEqual({
    params: {
      type: 'object',
      properties: { product_id: PRODUCT_ID.schema },
      required: ['product_id'],
      additionalProperties: false,
    },
    querystring: {
      type: 'object',
      properties: { limit: LIMIT_PATH_ITEM.schema },
      required: [],
      additionalProperties: false,
    },
  });
});

it('[ADR-0001 §4.2 #15] 不支持的契约写法在生成时就报错并写出 operationId：cookie 参数、数组或对象参数、style / explode / content、非必填或非 JSON 的请求体', () => {
  const base: ContractOperation = { operationId: 'badShape' };
  const withParam = (parameter: ContractParameter): ContractOperation => ({
    ...base,
    parameters: [parameter],
  });
  const cases: ContractOperation[] = [
    withParam({ name: 'sid', in: 'cookie', schema: { type: 'string' } }),
    withParam({ name: 'ids', in: 'query', schema: { type: 'array', items: { type: 'string' } } }),
    withParam({ name: 'filter', in: 'query', schema: { type: 'object', properties: {} } }),
    withParam({ name: 'X-Tags', in: 'header', schema: { type: 'array', items: {} } }),
    withParam({ name: 'limit', in: 'query', style: 'form', schema: { type: 'integer' } }),
    withParam({ name: 'limit', in: 'query', explode: false, schema: { type: 'integer' } }),
    withParam({
      name: 'q',
      in: 'query',
      content: { 'application/json': { schema: { type: 'object' } } },
    }),
    { ...base, requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } },
    {
      ...base,
      requestBody: {
        required: false,
        content: { 'application/json': { schema: { type: 'object' } } },
      },
    },
    {
      ...base,
      requestBody: {
        required: true,
        content: { 'application/x-www-form-urlencoded': { schema: { type: 'object' } } },
      },
    },
    {
      ...base,
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { type: 'object' } },
          'text/plain': { schema: { type: 'string' } },
        },
      },
    },
  ];
  const outcomes = cases.map((operation) => {
    try {
      routeSchemaOf(operation);
      return 'accepted';
    } catch (error) {
      return error instanceof Error && error.message.includes('badShape')
        ? 'refused naming the operation'
        : `refused without the operationId: ${String(error)}`;
    }
  });
  expect(outcomes).toEqual(cases.map(() => 'refused naming the operation'));
});
