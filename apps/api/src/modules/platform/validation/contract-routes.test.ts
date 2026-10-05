import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dereference } from '@readme/openapi-parser';
import type { OpenAPIV3_1 } from 'openapi-types';
import { expect, it } from 'vitest';
import { contractRouteSchema, type ContractOperationId } from '../index.ts';
import { routeSchemaOf, type ContractOperation, type ContractParameter } from './index.ts';
import { routeSchemasFile, routeSchemasSource } from './scripts/generate-route-schemas.ts';

it('[AC-B1-02c#1] the generated route schemas match the current contract', async () => {
  expect(await readFile(routeSchemasFile, 'utf8')).toBe(await routeSchemasSource());
});

it('[AC-B1-02c#1] exports routeSchemaOf of every implemented operation and refuses planned or unknown ones', async () => {
  const document = await dereference<OpenAPIV3_1.Document>(
    fileURLToPath(new URL('../../../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  const pathItem = document.paths?.['/v1/devices'];
  const operation = pathItem?.post;
  expect(operation?.operationId).toBe('registerDevice');
  expect(contractRouteSchema('registerDevice')).toEqual(
    routeSchemaOf(
      operation as unknown as ContractOperation,
      pathItem?.parameters as readonly ContractParameter[] | undefined,
    ),
  );
  expect(contractRouteSchema('getHealthz')).toEqual({});
  // Every operation still marked planned, taken from the contract rather than named here.
  const planned = Object.values(document.paths ?? {})
    .flatMap((item) => Object.values(item ?? {}) as unknown[])
    .filter(
      (candidate): candidate is { operationId: string } =>
        typeof candidate === 'object' &&
        candidate !== null &&
        'x-implementation' in candidate &&
        typeof (candidate as { operationId?: unknown }).operationId === 'string',
    )
    .map((candidate) => candidate.operationId);
  for (const id of [...planned, 'noSuchOperation', 'toString', '__proto__']) {
    expect(() => contractRouteSchema(id as ContractOperationId)).toThrow(
      /^No implemented contract operation /,
    );
  }
});
