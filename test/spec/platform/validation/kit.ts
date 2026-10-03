// Shared helpers of the platform/validation rule tests (ADR-0001 §4.2 第 15 项; 规划/04 §5, §7).
// Fastify is not imported: `fastifyValidationError` builds the same error object Fastify's
// wrapValidationError builds (code FST_ERR_VALIDATION, statusCode 400, `validation` = the Ajv
// errors, `validationContext` = the part), from a real failed validation.
import {
  createValidatorCompiler,
  type ContractOperation,
  type ContractParameter,
  type HttpPart,
  type JsonSchema,
  type ValidateFunction,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

/** Compiles `schema` for `part` with a fresh validator compiler. */
export function compile(schema: JsonSchema, part: HttpPart): ValidateFunction {
  return createValidatorCompiler()({ schema, httpPart: part, method: 'POST', url: '/v1/things' });
}

/** Validates `data` and, when it fails, returns the error Fastify would raise for `part`. */
export function fastifyValidationError(
  schema: JsonSchema,
  part: HttpPart,
  data: unknown,
): Error & { code: string; statusCode: number; validation: unknown; validationContext: string } {
  const validate = compile(schema, part);
  if (validate(data)) throw new Error(`expected ${part} to be invalid: ${JSON.stringify(data)}`);
  return Object.assign(new Error(`${part} is invalid`), {
    code: 'FST_ERR_VALIDATION',
    statusCode: 400,
    validation: validate.errors,
    validationContext: part,
  });
}

export const PRODUCT_ID: ContractParameter = {
  name: 'product_id',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^[a-z0-9]{1,32}$' },
};

export const APP_ID: ContractParameter = {
  name: 'X-App-Id',
  in: 'header',
  required: true,
  schema: { type: 'string', enum: ['couli', 'second'] },
};

export const LIMIT_PATH_ITEM: ContractParameter = {
  name: 'limit',
  in: 'query',
  schema: { type: 'integer', minimum: 1, maximum: 20 },
};

export const BODY_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['quantity', 'payee'],
  properties: {
    quantity: { type: 'integer', format: 'int32', minimum: 1 },
    note: { type: 'string', maxLength: 20 },
    payee: {
      type: 'object',
      additionalProperties: false,
      required: ['bank_name'],
      properties: { bank_name: { type: 'string', minLength: 1 } },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { price_fen: { type: 'integer', format: 'int64' } },
      },
    },
  },
};

/** A dereferenced operation using every supported part; `limit` overrides the path item's. */
export function sampleOperation(): ContractOperation {
  return {
    operationId: 'updateThing',
    parameters: [
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
      { name: 'cursor', in: 'query', required: true, schema: { type: 'string', minLength: 1 } },
      { name: 'X-Device-Id', in: 'header', required: true, schema: { type: 'string' } },
      {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        schema: { type: 'string', minLength: 8 },
      },
      PRODUCT_ID,
    ],
    requestBody: { required: true, content: { 'application/json': { schema: BODY_SCHEMA } } },
    responses: {
      '200': {
        description: 'ok',
        content: { 'application/json': { schema: { type: 'object', properties: {} } } },
      },
    },
  };
}
