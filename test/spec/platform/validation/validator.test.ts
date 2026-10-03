// Rule tests for createValidatorCompiler and validationErrorEnvelope (ADR-0001 §4.2 第 15 项: body
// without type coercion, query / params / headers with coerceTypes, both strict; 规划/04 §7: a
// failed validation answers 400 with code 20001 and data.fields; contract in
// apps/api/src/modules/platform/validation/index.ts). Expected values are written out by hand.
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  createValidatorCompiler,
  routeSchemaOf,
  validationErrorEnvelope,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  APP_ID,
  BODY_SCHEMA,
  compile,
  deepFreeze,
  fastifyValidationError,
  sampleOperation,
} from './kit.ts';

const QUERY_SCHEMA: JsonSchema = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['limit'],
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    with_tips: { type: 'boolean' },
    total_fen: { type: 'integer', format: 'int64' },
  },
});

const GOOD_BODY = { quantity: 2, payee: { bank_name: '招商银行' }, items: [{ price_fen: 1999 }] };

it('[ADR-0001 §4.2 #15] body 不做类型转换：字符串数字被拒，多余字段、缺字段、没有 body 都被拒，合规 body 原样通过', () => {
  const validate = compile(BODY_SCHEMA, 'body');
  const quantityAsText = { ...GOOD_BODY, quantity: '2' };
  const extra = { ...GOOD_BODY, coupon: 'x' };
  const missing = { quantity: 2 };
  const good = structuredClone(GOOD_BODY);
  expect([
    validate(good),
    validate(quantityAsText),
    validate(extra),
    validate(missing),
    validate(undefined),
  ]).toEqual([true, false, false, false, false]);
  expect({ good, quantityAsText }).toEqual({
    good: GOOD_BODY,
    quantityAsText: { ...GOOD_BODY, quantity: '2' },
  });
});

it('[ADR-0001 §4.2 #15] querystring、params、headers 开类型转换：字符串原地转成整数与布尔，转不了的被拒；headers 允许 schema 之外的头', () => {
  const query = { limit: '10', with_tips: 'true' };
  const badQuery = { limit: 'ten' };
  const params = { product_id: 'abc123' };
  const headerSchema = routeSchemaOf(sampleOperation(), [APP_ID]).headers ?? {};
  const headers = { 'x-app-id': 'couli', 'x-device-id': 'd-1', 'user-agent': 'ua', accept: '*/*' };
  const results = [
    compile(QUERY_SCHEMA, 'querystring')(query),
    compile(QUERY_SCHEMA, 'querystring')(badQuery),
    compile(
      {
        type: 'object',
        additionalProperties: false,
        required: ['product_id'],
        properties: { product_id: { type: 'string', pattern: '^[a-z0-9]{1,32}$' } },
      },
      'params',
    )(params),
    compile(headerSchema, 'headers')(headers),
    compile(headerSchema, 'headers')({ 'x-app-id': 'couli' }),
    compile(QUERY_SCHEMA, 'querystring')({ limit: '10', unknown: '1' }),
  ];
  const page = { page: '2' };
  const pageSize = { 'x-page-size': '20', accept: '*/*' };
  const typed = [
    compile(
      deepFreeze({
        type: 'object',
        additionalProperties: false,
        required: ['page'],
        properties: { page: { type: 'integer', minimum: 1 } },
      }),
      'params',
    )(page),
    compile(
      deepFreeze({
        type: 'object',
        required: ['x-page-size'],
        properties: { 'x-page-size': { type: 'integer', maximum: 50 } },
      }),
      'headers',
    )(pageSize),
  ];
  expect({ results, query, typed, page, pageSize }).toEqual({
    results: [true, false, true, true, false, false],
    query: { limit: 10, with_tips: true },
    typed: [true, true],
    page: { page: 2 },
    pageSize: { 'x-page-size': 20, accept: '*/*' },
  });
});

it('[ADR-0001 §4.2 #15] 严格模式：未知关键字、properties 不带 type: object、prefixItems 不带 minItems、required 里有 properties 没有的名字，编译即报错', () => {
  const compiler = createValidatorCompiler();
  const bad: JsonSchema[] = [
    { type: 'string', maxLenght: 3 },
    { properties: { a: { type: 'string' } }, unevaluatedProperties: false },
    { type: 'array', prefixItems: [{ type: 'string' }] },
    { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] },
  ];
  const outcomes = bad.flatMap((schema) =>
    (['body', 'querystring'] as const).map((httpPart) => {
      try {
        compiler({ schema, httpPart });
        return 'compiled';
      } catch {
        return 'refused';
      }
    }),
  );
  expect(outcomes).toEqual(Array.from({ length: bad.length * 2 }, () => 'refused'));
  expect(
    typeof compiler({
      schema: {
        type: 'object',
        properties: { a: { type: 'string' } },
        unevaluatedProperties: false,
      },
      httpPart: 'body',
    }),
  ).toBe('function');
});

it('[ADR-0001 §4.2 #15] int64 只收 ±(2^53−1) 以内的整数，int32 只收 −2^31 … 2^31−1；查询串里的数字先转换再判', () => {
  const int64Body = compile({ type: 'integer', format: 'int64' }, 'body');
  const int32Body = compile({ type: 'integer', format: 'int32' }, 'body');
  const int64Query = compile(QUERY_SCHEMA, 'querystring');
  expect({
    int64: [
      9007199254740991,
      -9007199254740991,
      0,
      9007199254740992,
      -9007199254740992,
      2 ** 63,
      1.5,
    ].map((v) => int64Body(v)),
    int32: [2147483647, -2147483648, 2147483648, -2147483649, 0.5].map((v) => int32Body(v)),
    query: ['9007199254740991', '9007199254740992', '9007199254740993'].map((v) =>
      int64Query({ limit: '1', total_fen: v }),
    ),
  }).toEqual({
    int64: [true, true, true, false, false, false, false],
    int32: [true, true, false, false, false],
    query: [true, false, false],
  });
});

it('[ADR-0001 §4.2 #15] ajv-formats 的格式照常生效（date-time、uuid），且一次报出全部错误（allErrors）', () => {
  const validate = compile(
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        at: { type: 'string', format: 'date-time' },
        id: { type: 'string', format: 'uuid' },
        n: { type: 'integer' },
      },
    },
    'body',
  );
  expect([
    validate({ at: '2026-10-03T12:00:00Z', id: '0f8fad5b-d9cb-469f-a165-70867728950e', n: 1 }),
    validate({ at: '2026-13-03T12:00:00Z' }),
    validate({ id: 'not-a-uuid' }),
  ]).toEqual([true, false, false]);
  validate({ at: 'yesterday', id: 'x', n: 'one', extra: true });
  expect(
    [
      ...new Set(
        (validate.errors ?? []).map(
          (e) => e.instancePath || String(e.params['additionalProperty']),
        ),
      ),
    ].sort(),
  ).toEqual(['/at', '/id', '/n', 'extra']);
});

it('[规划/04 §7 20001] 校验失败回 400 与 ErrorEnvelope：code 20001、data.fields 按出错顺序列出每个字段一次（嵌套用点连接、数组下标在内）、带 trace_id，msg 不回显提交的值', () => {
  const submitted = 'submitted value 62220212 34567890';
  const error = fastifyValidationError(BODY_SCHEMA, 'body', {
    quantity: 0,
    note: submitted,
    payee: {},
    items: [{ price_fen: 1 }, { price_fen: 'x' }],
    [submitted]: 1,
  });
  const response = validationErrorEnvelope(error, 'trace-abc_123');
  expect(response).toEqual({
    statusCode: 400,
    body: {
      code: 20001,
      msg: response?.body.msg,
      data: { fields: [submitted, 'quantity', 'note', 'payee.bank_name', 'items.1.price_fen'] },
      trace_id: 'trace-abc_123',
    },
  });
  expect({
    msgIsText: typeof response?.body.msg === 'string' && response.body.msg.length > 0,
    echoes: (response?.body.msg ?? '').includes('62220212'),
  }).toEqual({ msgIsText: true, echoes: false });
});

it('[规划/04 §7 20001] fields 的名字：JSON pointer 转义还原（~1 → /，~0 → ~），重复只列一次，整段缺失时写段名，headers 与 querystring 写参数名', () => {
  const pointerSchema: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      'a/b': { type: 'integer' },
      'c~d': { type: 'object', required: ['e'], properties: { e: { type: 'string' } } },
    },
  };
  const headerSchema = routeSchemaOf(sampleOperation(), [APP_ID]).headers ?? {};
  const fieldsOf = (error: Error): unknown => validationErrorEnvelope(error, 't')?.body.data.fields;
  expect({
    pointer: fieldsOf(fastifyValidationError(pointerSchema, 'body', { 'a/b': 'x', 'c~d': {} })),
    duplicate: fieldsOf(
      fastifyValidationError(
        { type: 'object', properties: { n: { type: 'integer', minimum: 5, multipleOf: 2 } } },
        'body',
        { n: 3 },
      ),
    ),
    missingBody: fieldsOf(fastifyValidationError(BODY_SCHEMA, 'body', undefined)),
    headers: fieldsOf(fastifyValidationError(headerSchema, 'headers', { 'x-app-id': 'other' })),
    query: fieldsOf(fastifyValidationError(QUERY_SCHEMA, 'querystring', { limit: '99' })),
  }).toEqual({
    pointer: ['a/b', 'c~d.e'],
    duplicate: ['n'],
    missingBody: ['body'],
    headers: ['x-device-id', 'x-app-id'],
    query: ['limit'],
  });
});

it('[规划/04 §7 20001] 不是 FST_ERR_VALIDATION 的错误不处理（返回 undefined），交给原有的异常处理', () => {
  const others: unknown[] = [
    new Error('boom'),
    Object.assign(new Error('Unsupported Media Type'), {
      code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE',
      statusCode: 415,
    }),
    Object.assign(new Error('no list'), { code: 'FST_ERR_VALIDATION', statusCode: 400 }),
    Object.assign(new Error('bad list'), {
      code: 'FST_ERR_VALIDATION',
      statusCode: 400,
      validation: 'oops',
      validationContext: 'body',
    }),
    undefined,
    null,
    'FST_ERR_VALIDATION',
    { code: 'FST_ERR_VALIDATION' },
  ];
  expect(others.map((error) => validationErrorEnvelope(error, 't'))).toEqual(
    others.map(() => undefined),
  );
});

it('[ADR-0001 §4.2 #15] 从契约操作生成的各段 schema 编译后能直接校验请求，出错时得到对应段的 20001', () => {
  const schema = routeSchemaOf(sampleOperation(), [APP_ID]);
  const compiler = createValidatorCompiler();
  const parts = {
    params: { product_id: 'abc123' },
    querystring: { cursor: 'c1', limit: '5' },
    headers: { 'x-app-id': 'couli', 'x-device-id': 'd-1' },
    body: structuredClone(GOOD_BODY),
  } as const;
  const valid = (['params', 'querystring', 'headers', 'body'] as const).map((part) =>
    compiler({ schema: schema[part] ?? {}, httpPart: part })(parts[part]),
  );
  const badBody = { ...GOOD_BODY, quantity: 2147483648 };
  const fields = validationErrorEnvelope(
    fastifyValidationError(schema.body ?? {}, 'body', badBody),
    't-9',
  )?.body;
  expect({ valid, query: parts.querystring, fields }).toEqual({
    valid: [true, true, true, true],
    query: { cursor: 'c1', limit: 5 },
    fields: { code: 20001, msg: fields?.msg, data: { fields: ['quantity'] }, trace_id: 't-9' },
  });
});
