import { expect, it } from 'vitest';
import { PATH, contract } from './kit.ts';

it('[AC-B1-11g#26] sendLandingSmsCode 移除 planned，保持匿名、不签名、不判版本的 phone-only 契约', async () => {
  const document = await contract();
  const operation = document.paths[PATH]!.post;
  expect(operation['x-implementation']).not.toBe('planned');
  expect(operation).toMatchObject({
    operationId: 'sendLandingSmsCode',
    'x-auth': 'none',
    'x-signed': false,
    'x-min-version-gate': false,
    security: [],
  });
  expect(operation.parameters.map((p) => p.name.toLowerCase())).not.toContain('x-device-id');
  expect(operation.requestBody.content['application/json']!.schema).toMatchObject({
    additionalProperties: false,
    required: ['phone'],
  });
  expect(
    Object.keys(operation.requestBody.content['application/json']!.schema['properties'] as object),
  ).toEqual(['phone']);
  expect(operation.responses['200']!.content['application/json']!.schema).toEqual(
    document.paths['/v1/auth/sms-codes']!.post.responses['200']!.content['application/json']!
      .schema,
  );
});
