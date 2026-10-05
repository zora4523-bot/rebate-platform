// Route schemas of the implemented contract operations, for controllers outside the platform
// module (`@RouteSchema(contractRouteSchema('registerDevice'))`). The schemas are generated from
// contracts/openapi.yaml by ./scripts/generate-route-schemas.ts with `routeSchemaOf`.
// Erasable syntax only, no NestJS, no package import (this directory is also compiled by the
// `test` project).
import { CONTRACT_ROUTE_SCHEMAS } from './route-schemas.gen.ts';

/** operationId of an implemented contract operation (no `x-implementation: planned`). */
export type ContractOperationId = keyof typeof CONTRACT_ROUTE_SCHEMAS;

/**
 * The request schema of an implemented operation. Throws for anything else (a planned or
 * unknown operation), so a controller cannot start without the contract's validation.
 */
export function contractRouteSchema<Id extends ContractOperationId>(
  operationId: Id,
): (typeof CONTRACT_ROUTE_SCHEMAS)[Id] {
  if (!Object.hasOwn(CONTRACT_ROUTE_SCHEMAS, operationId)) {
    throw new Error(`No implemented contract operation ${String(operationId)}`);
  }
  return CONTRACT_ROUTE_SCHEMAS[operationId];
}
