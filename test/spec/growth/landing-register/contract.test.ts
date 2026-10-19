import { expect, it } from 'vitest';
import { contract } from '../../identity/landing-sms/kit.ts';
import { PATH } from './kit.ts';

it('[AC-B1-11h#1] landingRegister 去掉 planned，保持匿名、免签、无设备和版本门及严格请求形状', async () => {
  const operation = (await contract()).paths[PATH]!.post;
  expect(operation['x-implementation']).not.toBe('planned');
  expect(operation).toMatchObject({
    operationId: 'landingRegister',
    'x-auth': 'none',
    'x-signed': false,
    'x-idempotent': true,
    'x-min-version-gate': false,
    security: [],
  });
  expect(
    operation.parameters.find((p) => p.name.toLowerCase() === 'idempotency-key'),
  ).toMatchObject({ required: true });
  expect(operation.parameters.map((p) => p.name.toLowerCase())).not.toContain('x-device-id');
  const schema = operation.requestBody.content['application/json']!.schema;
  expect(schema).toMatchObject({
    additionalProperties: false,
    required: ['phone', 'sms_code', 'invite_code', 'agreed'],
  });
  expect(Object.keys(schema['properties'] as object).sort()).toEqual([
    'agreed',
    'channel',
    'invite_code',
    'phone',
    'sms_code',
  ]);
});
