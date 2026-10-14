import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { OpenAPIV3_1 } from 'openapi-types';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import ajvFormats from 'ajv-formats';

// Load the shared, erasable TypeScript parser with Node, outside the API build's rootDir.
// src/ and dist/ have the same depth, so this also works from the built entry point.
const { parseYamlLite } = createRequire(import.meta.url)(
  '../../../../../../tools/lib/yaml-lite.ts',
) as {
  parseYamlLite(text: string): unknown;
};

// Compile once during module initialization, before any HTTP instance or request is created.
// Every instance shares this validator; constructing an instance performs no contract I/O.
const validator: ValidateFunction = load();

/** sendAgentMessage is planned, so it is absent from the generated route schemas. */
export function messageValidator(): ValidateFunction {
  return validator;
}

function load(): ValidateFunction {
  const document = parseYamlLite(
    readFileSync(new URL('../../../../../../contracts/openapi.yaml', import.meta.url), 'utf8'),
  ) as OpenAPIV3_1.Document;
  const schema = document.components?.schemas?.['AgentMessageRequest'];
  if (!schema) throw new Error('Missing AgentMessageRequest contract');
  const ajv = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false });
  ajvFormats.default(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) => Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  return ajv.compile(resolveLocalSchema(schema, document) as object);
}

/** Expand only the request's local references, with no file or network resolvers. */
function resolveLocalSchema(
  value: unknown,
  document: OpenAPIV3_1.Document,
  ancestors: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => resolveLocalSchema(item, document, ancestors));
  }
  if (value === null || typeof value !== 'object') return value;
  const { $ref, ...rest } = value as Record<string, unknown>;
  if ($ref !== undefined) {
    if (typeof $ref !== 'string' || !$ref.startsWith('#/') || ancestors.has($ref)) {
      throw new Error('Agent request schema requires a non-circular local reference');
    }
    let target: unknown = document;
    for (const part of $ref.slice(2).split('/')) {
      const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
      if (target === null || typeof target !== 'object' || !Object.hasOwn(target, key)) {
        throw new Error('Missing agent request schema reference');
      }
      target = (target as Record<string, unknown>)[key];
    }
    const resolved = resolveLocalSchema(target, document, new Set([...ancestors, $ref]));
    // Keep JSON Schema reference siblings as additional constraints.
    return Object.keys(rest).length === 0
      ? resolved
      : { allOf: [resolved, resolveLocalSchema(rest, document, ancestors)] };
  }
  return Object.fromEntries(
    Object.entries(rest).map(([key, item]) => [key, resolveLocalSchema(item, document, ancestors)]),
  );
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
