// Build-time only. Run from the repository root with:
// node apps/api/src/modules/platform/validation/scripts/generate-route-schemas.ts
// Writes ../route-schemas.gen.ts: the Fastify route schema (`routeSchemaOf`) of every implemented
// contract operation, keyed by operationId. Business modules mount them through
// `contractRouteSchema(operationId)` of the platform module's index.ts; the contract parser is a
// build-time dependency, so the schemas are generated here instead of read at run time.
// Implemented = the operation has no `x-implementation` marker (contracts/README rule 10). Rerun
// after changing the contract or removing a planned marker; contract-routes.test.ts fails until
// the generated file matches.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dereference } from '@readme/openapi-parser';
import type { OpenAPIV3_1 } from 'openapi-types';
import {
  routeSchemaOf,
  createValidatorCompiler,
  type ContractOperation,
  type ContractParameter,
} from '../index.ts';

export const routeSchemasFile = new URL('../route-schemas.gen.ts', import.meta.url);

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export async function routeSchemasSource(): Promise<string> {
  const document = await dereference<OpenAPIV3_1.Document>(
    fileURLToPath(new URL('../../../../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  const compiler = createValidatorCompiler();
  const schemas: Record<string, unknown> = {};
  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = pathItem?.[method];
      if (operation === undefined || 'x-implementation' in operation) continue;
      const operationId = operation.operationId;
      if (operationId === undefined) throw new Error('Contract operation without operationId');
      const schema = routeSchemaOf(
        operation as unknown as ContractOperation,
        pathItem?.parameters as readonly ContractParameter[] | undefined,
      );
      // Fail here, not at application start, when a part does not compile in strict mode.
      for (const [httpPart, partSchema] of Object.entries(schema)) {
        compiler({ schema: partSchema, httpPart });
      }
      schemas[operationId] = schema;
    }
  }
  return (
    '// Generated from contracts/openapi.yaml by platform/validation/scripts/generate-route-schemas.ts.\n' +
    '// Do not edit by hand. Regenerate after contract changes.\n' +
    `export const CONTRACT_ROUTE_SCHEMAS = ${JSON.stringify(schemas, null, 2)} as const;\n`
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(routeSchemasFile, await routeSchemasSource());
}
