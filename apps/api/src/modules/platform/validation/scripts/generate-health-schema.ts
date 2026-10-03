// Build-time only. Run from the repository root with:
// node apps/api/src/modules/platform/validation/scripts/generate-health-schema.ts
// Keep the generated schema beside its controller so health has no private platform import.
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

export const healthSchemaFile = new URL(
  '../../../health/http/public/health.schema.gen.ts',
  import.meta.url,
);

export async function healthSchemaSource(): Promise<string> {
  const document = await dereference<OpenAPIV3_1.Document>(
    fileURLToPath(new URL('../../../../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  const pathItem = document.paths?.['/healthz'];
  const operation = pathItem?.get;
  if (operation?.operationId !== 'getHealthz')
    throw new Error('Missing contract operation getHealthz');
  const schema = routeSchemaOf(
    operation as unknown as ContractOperation,
    pathItem?.parameters as readonly ContractParameter[] | undefined,
  );
  const compiler = createValidatorCompiler();
  for (const [httpPart, partSchema] of Object.entries(schema)) {
    compiler({ schema: partSchema, httpPart });
  }
  return (
    '// Generated from contracts/openapi.yaml by platform/validation/scripts/generate-health-schema.ts.\n' +
    '// Do not edit by hand. Regenerate after contract changes.\n' +
    `export const healthRouteSchema = ${JSON.stringify(schema, null, 2)} as const;\n`
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(healthSchemaFile, await healthSchemaSource());
}
