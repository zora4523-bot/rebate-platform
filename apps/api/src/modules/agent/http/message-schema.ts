import { fileURLToPath } from 'node:url';
import { dereference } from '@readme/openapi-parser';
import type { OpenAPIV3_1 } from 'openapi-types';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import ajvFormats from 'ajv-formats';

let validator: Promise<ValidateFunction> | undefined;

/** sendAgentMessage is planned, so it is absent from the generated route schemas. */
export function messageValidator(): Promise<ValidateFunction> {
  validator ??= load().catch((error: unknown) => {
    validator = undefined;
    throw error;
  });
  return validator;
}

async function load(): Promise<ValidateFunction> {
  const document = await dereference<OpenAPIV3_1.Document>(
    fileURLToPath(new URL('../../../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  const schema = document.components?.schemas?.['AgentMessageRequest'];
  if (!schema) throw new Error('Missing AgentMessageRequest contract');
  const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false });
  ajvFormats.default(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) => Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  return ajv.compile(schema);
}

/** Same field paths as platform validationErrorEnvelope, without crossing its private boundary. */
export function invalidFields(errors: readonly ErrorObject[]): string[] {
  const fields = new Set<string>();
  for (const error of errors) {
    const path =
      error.instancePath === ''
        ? []
        : error.instancePath
            .slice(1)
            .split('/')
            .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    const property: unknown =
      error.keyword === 'required'
        ? error.params['missingProperty']
        : error.keyword === 'additionalProperties'
          ? error.params['additionalProperty']
          : undefined;
    if (typeof property === 'string') path.push(property);
    fields.add(path.length ? path.join('.') : 'body');
  }
  return [...fields];
}
