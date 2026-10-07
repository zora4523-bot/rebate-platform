import { expect, it } from 'vitest';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import {
  routeSchemaOf,
  type RouteSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { contract } from './kit.ts';

it('[AC-B1-07b#13] parseInput不再planned，optional鉴权与生成的请求schema和契约一致', async () => {
  const { operation } = await contract();
  expect(operation).not.toHaveProperty('x-implementation');
  expect(operation.operationId).toBe('parseInput');
  expect(operation['x-auth']).toBe('optional');
  const generated: Readonly<Record<string, RouteSchema>> = CONTRACT_ROUTE_SCHEMAS;
  expect(generated['parseInput']).toBeDefined();
  expect(generated['parseInput']).toEqual(routeSchemaOf(operation));
});
