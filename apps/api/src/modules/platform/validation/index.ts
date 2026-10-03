// Request validation from the contract (ADR-0001 §2 契约行, §4.2 第 15 项; 规划/04 §5 请求头,
// §7 错误码 20001). Every function below throws `NotImplemented` until task B1-01d implements it.
// The rule tests in test/spec/platform/validation/** import this file by path; names, signatures
// and the semantics written here are the contract.
//
// routeSchemaOf(operation, pathItemParameters?) → RouteSchema
//   `operation` is one operation of the dereferenced contracts/openapi.yaml (OAS 3.1, no `$ref`
//   left); `pathItemParameters` are the parameters declared on its path item. An operation
//   parameter replaces a path-item parameter with the same `in` and name (header names compared
//   without regard to case). Parts, each present only when it has something to validate:
//   - params       every `in: path` parameter: { type: 'object', properties, required: [every
//                  path parameter], additionalProperties: false }
//   - querystring  every `in: query` parameter: { type: 'object', properties, required: [the
//                  required ones], additionalProperties: false } (unknown query keys are refused)
//   - headers      every `in: header` parameter, its name lower-cased: { type: 'object',
//                  properties, required: [the required ones] } (other headers stay allowed:
//                  no additionalProperties keyword)
//   - body         `requestBody.content['application/json'].schema`, unchanged
//   `properties` maps each name to the parameter's `schema`, unchanged; `required` is always
//   present (possibly empty) and keeps the declaration order, path-item parameters first. There is never a `response` part (it would
//   silently drop fields; responses are checked in tests). Shapes this module does not support
//   throw an Error naming the operation: a `cookie` parameter, a parameter whose schema is an
//   array or an object, a `style` / `explode` / `content` on a parameter, a request body that is
//   not `required: true`, and request content other than exactly `application/json`.
//
// createValidatorCompiler() → the Fastify `validatorCompiler`
//   Called with { schema, httpPart } (also method and url, unused); returns the compiled
//   validate function (a false result carries Ajv's `errors`). Two Ajv2020 instances, both with
//   `strict: true` and `allErrors: true`: `httpPart` 'body' uses one without type coercion; every
//   other part ('querystring', 'params', 'headers') uses one with `coerceTypes: true` (their
//   values arrive as strings and are converted in place). Formats: ajv-formats, with `int32`
//   (an integer in −2^31 … 2^31−1) and `int64` replaced by this module's own: an integer within
//   ±(2^53 − 1), so an amount that JavaScript cannot hold exactly is refused. Strict mode makes a
//   bad contract fail when the route is compiled (application start): an unknown keyword,
//   `properties` / `unevaluatedProperties` without `type: 'object'`, `prefixItems` without
//   `minItems`, a `required` name that is not in `properties`.
//
// validationErrorEnvelope(error, traceId) → ValidationErrorResponse | undefined
//   For Fastify's validation error (code 'FST_ERR_VALIDATION', `validation`: Ajv errors,
//   `validationContext`: 'body' | 'querystring' | 'params' | 'headers'): HTTP 400 and the
//   contract ErrorEnvelope { code: 20001, msg, data: { fields }, trace_id: traceId }. `fields`
//   names every offending field once, in the order of the Ajv errors: `missingProperty` of a
//   `required` error, `additionalProperty` of an `additionalProperties` error, otherwise the
//   error's instancePath; a name is the path from the part's root, its JSON-pointer segments
//   unescaped (~1 → /, ~0 → ~) and joined with '.', array indexes included (items.0.price). An
//   error at the root of a part with no property (for example a missing body) names the part
//   itself ('body', 'querystring', 'params', 'headers'). `msg` is a non-empty fallback text
//   that never repeats a submitted value. Any other error (not FST_ERR_VALIDATION, or without
//   an array `validation`) → undefined: the caller handles it as before.
//
// Wiring (bootstrap.ts, covered by the implementer's unit tests through Fastify `inject`): the
// Fastify instance uses createValidatorCompiler(); a global Nest exception filter answers
// FST_ERR_VALIDATION with validationErrorEnvelope and the request's trace id (Nest would answer
// 500); controllers mount route schemas with `@RouteSchema`.
//
// Rules for the implementation: this file is also compiled by the `test` project: erasable syntax
// only (no parameter properties, no enum, no namespace, no decorators), `import type` for
// type-only imports, relative imports with the `.ts` extension, no NestJS import, no
// `process.env`. Allowed packages: ajv, ajv-formats (already dependencies of @couli/api).

/** A JSON Schema object (draft 2020-12 as used by OAS 3.1). */
export type JsonSchema = { readonly [keyword: string]: unknown };

export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

/** An OAS 3.1 parameter object after dereferencing. */
export interface ContractParameter {
  readonly name: string;
  readonly in: ParameterLocation;
  readonly required?: boolean;
  readonly schema?: JsonSchema;
  readonly style?: string;
  readonly explode?: boolean;
  readonly content?: { readonly [mediaType: string]: unknown };
  readonly [extension: string]: unknown;
}

/** The parts of an OAS 3.1 operation that request validation reads. */
export interface ContractOperation {
  readonly operationId?: string;
  readonly parameters?: readonly ContractParameter[];
  readonly requestBody?: {
    readonly required?: boolean;
    readonly content?: { readonly [mediaType: string]: { readonly schema?: JsonSchema } };
  };
  readonly [field: string]: unknown;
}

/** Fastify route schema: only the request parts, never `response`. */
export interface RouteSchema {
  readonly params?: JsonSchema;
  readonly querystring?: JsonSchema;
  readonly headers?: JsonSchema;
  readonly body?: JsonSchema;
}

export type HttpPart = 'body' | 'querystring' | 'params' | 'headers';

/** What Fastify passes to its validatorCompiler. */
export interface ValidatorRoute {
  readonly schema: JsonSchema;
  readonly httpPart?: string;
  readonly method?: string;
  readonly url?: string;
}

/** A compiled validator: true when valid; after false, `errors` holds the Ajv errors. */
export type ValidateFunction = ((data: unknown) => boolean) & {
  errors?: readonly ValidationIssue[] | null;
};

/** The fields of an Ajv error that the envelope reads. */
export interface ValidationIssue {
  readonly keyword: string;
  readonly instancePath: string;
  readonly params: { readonly [name: string]: unknown };
  readonly message?: string;
}

export interface ValidationErrorResponse {
  readonly statusCode: 400;
  readonly body: {
    readonly code: 20001;
    readonly msg: string;
    readonly data: { readonly fields: readonly string[] };
    readonly trace_id: string;
  };
}

export function routeSchemaOf(
  operation: ContractOperation,
  pathItemParameters?: readonly ContractParameter[],
): RouteSchema {
  void operation;
  void pathItemParameters;
  throw new Error('NotImplemented');
}

export function createValidatorCompiler(): (route: ValidatorRoute) => ValidateFunction {
  throw new Error('NotImplemented');
}

export function validationErrorEnvelope(
  error: unknown,
  traceId: string,
): ValidationErrorResponse | undefined {
  void error;
  void traceId;
  throw new Error('NotImplemented');
}
