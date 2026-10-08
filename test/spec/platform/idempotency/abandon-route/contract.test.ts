import { expect, it } from 'vitest';
import { routeSchemaOf } from '../../../../../apps/api/src/modules/platform/validation/index.ts';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { contract } from './http-kit.ts';

it('[AC-B1-02g#1] 作废契约去 planned 并生成一致请求 schema，保留鉴权、签名与条件作用域元数据', async () => {
  const operation = await contract();
  expect(operation).not.toHaveProperty('x-implementation');
  expect(operation).toMatchObject({
    operationId: 'abandonIdempotencyKey',
    'x-auth': 'login',
    'x-signed': true,
    'x-idempotent': false,
    'x-min-version-gate': 'conditional',
    'x-session-scopes': ['full', 'deletion_only'],
    security: [{ bearerAuth: [] }],
  });
  expect(operation).not.toHaveProperty('x-step-up');
  expect(CONTRACT_ROUTE_SCHEMAS).toHaveProperty('abandonIdempotencyKey');
  expect(Reflect.get(CONTRACT_ROUTE_SCHEMAS, 'abandonIdempotencyKey')).toEqual(
    routeSchemaOf(operation),
  );
});
