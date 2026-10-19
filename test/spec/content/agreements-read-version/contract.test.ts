import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { PATH, ROOT, apiRequire, DATA_KEYS } from './kit.ts';

it('[AC-F1-02ze#13] getAgreementVersion 启用并生成 schema，三类匿名不签名，响应恰八字段', async () => {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{
      paths: Record<string, { get: Record<string, unknown> }>;
      components: {
        schemas: Record<
          string,
          { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean }
        >;
      };
    }>;
  };
  const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
  const operation = doc.paths[PATH]!.get;
  expect(operation['x-implementation']).not.toBe('planned');
  expect(Object.hasOwn(CONTRACT_ROUTE_SCHEMAS, 'getAgreementVersion')).toBe(true);
  expect(operation).toMatchObject({
    operationId: 'getAgreementVersion',
    'x-auth': 'none',
    'x-signed': false,
    security: [],
    'x-error-codes': expect.arrayContaining([30701]),
  });
  expect(operation).not.toHaveProperty('x-session-scopes');
  const parameters = operation['parameters'] as {
    name: string;
    in: string;
    required?: boolean;
    schema: unknown;
  }[];
  expect(parameters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'type',
        in: 'path',
        required: true,
        schema: expect.objectContaining({ enum: ['privacy', 'agreement', 'labor_agreement'] }),
      }),
      expect.objectContaining({
        name: 'version',
        in: 'query',
        required: false,
        schema: expect.objectContaining({ type: 'integer', format: 'int32', minimum: 1 }),
      }),
    ]),
  );
  expect(parameters.some((parameter) => parameter.name.toLowerCase() === 'x-device-id')).toBe(
    false,
  );
  const shape = doc.components.schemas['PublicAgreementVersion']!;
  expect(shape.additionalProperties).toBe(false);
  expect([...shape.required].sort()).toEqual(DATA_KEYS);
  expect(Object.keys(shape.properties).sort()).toEqual(DATA_KEYS);
  expect(doc.paths['/v1/agreements']!.get).toMatchObject({
    operationId: 'getAgreements',
    'x-auth': 'none',
    'x-signed': false,
    security: [],
    'x-error-codes': [],
  });
});
