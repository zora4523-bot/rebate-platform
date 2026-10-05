// Build-time only. Run from the repository root with:
// node apps/api/src/modules/identity/http/public/scripts/generate-route-schemas.ts
// Writes the Fastify route schemas of the identity operations, taken from contracts/openapi.yaml,
// beside the controllers (as platform/validation/scripts/generate-health-schema.ts does for
// health). platform/validation is not part of the platform module's public surface, so the
// conversion below follows its `routeSchemaOf` (same parts, same order, same refusals); the
// controller test checks that the generated file is current and that the routes compile.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dereference } from '@readme/openapi-parser';
import type { OpenAPIV3_1 } from 'openapi-types';

/** operationId → exported constant, in output order. Later identity tasks add theirs here. */
const OPERATIONS: readonly (readonly [operationId: string, constant: string])[] = [
  ['registerDevice', 'registerDeviceRouteSchema'],
];

export const routeSchemasFile = new URL('../route-schemas.gen.ts', import.meta.url);
const contractFile = new URL('../../../../../../../../contracts/openapi.yaml', import.meta.url);

type JsonSchema = { readonly [keyword: string]: unknown };

interface Parameter {
  readonly name: string;
  readonly in: string;
  readonly required?: boolean;
  readonly schema?: JsonSchema;
  readonly [field: string]: unknown;
}

interface Operation {
  readonly operationId?: string;
  readonly parameters?: readonly Parameter[];
  readonly requestBody?: {
    readonly required?: boolean;
    readonly content?: { readonly [mediaType: string]: { readonly schema?: JsonSchema } };
  };
}

type Part = 'params' | 'querystring' | 'headers';

function structured(schema: JsonSchema): boolean {
  const types = Array.isArray(schema['type']) ? schema['type'] : [schema['type']];
  if (types.includes('array') || types.includes('object')) return true;
  return ['allOf', 'anyOf', 'oneOf'].some((keyword) => {
    const branches = schema[keyword];
    return Array.isArray(branches) && branches.some((branch: JsonSchema) => structured(branch));
  });
}

/** Request parts only (never `response`), as platform/validation `routeSchemaOf`. */
export function routeSchemaFor(
  operation: Operation,
  pathItemParameters: readonly Parameter[] = [],
): Record<string, JsonSchema> {
  const fail = (reason: string): never => {
    throw new Error(`${operation.operationId ?? '(unnamed operation)'}: ${reason}`);
  };
  const parameters = new Map<string, Parameter>();
  for (const parameter of [...pathItemParameters, ...(operation.parameters ?? [])]) {
    const name = parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name;
    parameters.set(`${parameter.in}:${name}`, { ...parameter, name });
  }
  const groups = new Map<Part, Parameter[]>();
  for (const parameter of parameters.values()) {
    if (!['path', 'query', 'header'].includes(parameter.in)) {
      fail(`unsupported parameter location: ${parameter.in}`);
    }
    if (['style', 'explode', 'content'].some((key) => key in parameter)) {
      fail(`unsupported serialization for ${parameter.name}`);
    }
    if (parameter.schema === undefined || structured(parameter.schema)) {
      fail(`unsupported parameter schema for ${parameter.name}`);
    }
    const part: Part =
      parameter.in === 'path' ? 'params' : parameter.in === 'query' ? 'querystring' : 'headers';
    groups.set(part, [...(groups.get(part) ?? []), parameter]);
  }
  const result: Record<string, JsonSchema> = {};
  for (const [part, group] of groups) {
    result[part] = {
      type: 'object',
      properties: Object.fromEntries(group.map((parameter) => [parameter.name, parameter.schema])),
      required: group
        .filter((parameter) => part === 'params' || parameter.required === true)
        .map((parameter) => parameter.name),
      ...(part === 'headers' ? {} : { additionalProperties: false }),
    };
  }
  if (operation.requestBody !== undefined) {
    const { required, content } = operation.requestBody;
    const schema = content?.['application/json']?.schema;
    if (required !== true || Object.keys(content ?? {}).length !== 1 || schema === undefined) {
      fail('request body must be required and contain only application/json with a schema');
    }
    result['body'] = schema as JsonSchema;
  }
  return result;
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

export async function routeSchemasSource(): Promise<string> {
  const document = await dereference<OpenAPIV3_1.Document>(fileURLToPath(contractFile), {
    resolve: { external: false },
  });
  let source =
    '// Generated from contracts/openapi.yaml by identity/http/public/scripts/generate-route-schemas.ts.\n' +
    '// Do not edit by hand. Regenerate after contract changes.\n';
  for (const [operationId, constant] of OPERATIONS) {
    const found = Object.values(document.paths ?? {}).flatMap((item) =>
      METHODS.flatMap((method) =>
        item?.[method]?.operationId === operationId ? [{ item, operation: item[method] }] : [],
      ),
    );
    if (found.length !== 1) throw new Error(`Missing contract operation ${operationId}`);
    const { item, operation } = found[0]!;
    const schema = routeSchemaFor(
      operation as unknown as Operation,
      item.parameters as unknown as readonly Parameter[] | undefined,
    );
    source += `export const ${constant} = ${JSON.stringify(schema, null, 2)} as const;\n`;
  }
  return source;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(routeSchemasFile, await routeSchemasSource());
}
