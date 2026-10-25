// B1-12z · Contract validation of the console channel page's query strings and bodies, run by the
// use cases at the point of the contract's order of checks (CT-24t: permission and step-up, then
// `code`, a fund code's content.fund_terms, what the code allows and `variant` all come before the
// body). The routes therefore mount no route schema; the parts come from the generated route
// schemas of the same operations (platform contractRouteSchema) and are compiled the way
// platform's validator compiler does it: Ajv 2020, strict, all errors, query values coerced, the
// body not; int32 / int64 as platform's. Field names follow platform's validationErrorEnvelope.
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import ajvFormats from 'ajv-formats';
import { contractRouteSchema } from '../../../platform/index.ts';
import type { NotifyValidators, RequestValidator } from '../../admin-channels/service.ts';

type Part = 'querystring' | 'body';
type JsonSchema = { readonly [keyword: string]: unknown };

function createAjv(coerceTypes: boolean): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes });
  ajvFormats.default(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) =>
      Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  return ajv;
}

/** The offending fields of Ajv's errors, as platform's validationErrorEnvelope names them. */
export function invalidFields(errors: readonly ErrorObject[], part: Part): string[] {
  const fields = new Set<string>();
  for (const error of errors) {
    const segments =
      error.instancePath === ''
        ? []
        : error.instancePath
            .slice(1)
            .split('/')
            .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
    const property: unknown =
      error.keyword === 'required'
        ? error.params['missingProperty']
        : error.keyword === 'additionalProperties'
          ? error.params['additionalProperty']
          : undefined;
    if (typeof property === 'string') segments.push(property);
    fields.add(segments.length > 0 ? segments.join('.') : part);
  }
  return [...fields];
}

function validator(compiled: ValidateFunction, part: Part): RequestValidator {
  return (value) => (compiled(value) ? null : invalidFields(compiled.errors ?? [], part));
}

/** No query parameters at all (an operation without a query part). */
const NO_QUERY: JsonSchema = { type: 'object', additionalProperties: false };

/** Built once per entry: compiling at startup makes a bad contract fail there, not per request. */
export function createNotifyValidators(): NotifyValidators {
  const query = createAjv(true);
  const body = createAjv(false);
  const part = (schema: JsonSchema | undefined, kind: Part): RequestValidator =>
    validator((kind === 'body' ? body : query).compile(schema ?? NO_QUERY), kind);
  const register = contractRouteSchema('adminRegisterNotifySms');
  const retest = contractRouteSchema('adminRetestNotifySms');
  const enable = contractRouteSchema('adminEnableNotifySms');
  const discard = contractRouteSchema('adminDiscardNotifySms');
  return {
    switchBody: part(contractRouteSchema('adminSwitchNotifyChannels').body, 'body'),
    registerQuery: part(register.querystring, 'querystring'),
    registerBody: part(register.body, 'body'),
    retestQuery: part(retest.querystring, 'querystring'),
    retestBody: part(retest.body, 'body'),
    enableQuery: part(enable.querystring, 'querystring'),
    enableBody: part(enable.body, 'body'),
    discardQuery: part(discard.querystring, 'querystring'),
  };
}
