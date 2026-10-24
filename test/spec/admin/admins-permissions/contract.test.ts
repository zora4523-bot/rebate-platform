import { expect, it } from 'vitest';
import { contract } from '../exports/kit.ts';
import { OPERATION_ID, PATH } from './kit.ts';

it('[AC-B1-34k#1] 权限点整组保存保持 super 鉴权、动态码档 step-up 头与 CAS 字段，并去掉 planned', async () => {
  const spec = (await contract()).paths[PATH]!['put']!;
  expect(spec).toMatchObject({ operationId: OPERATION_ID, 'x-auth': 'super' });
  const parameters = (spec as unknown as { parameters?: { name?: string }[] }).parameters;
  expect((parameters ?? []).some((parameter) => parameter.name === 'X-Step-Up-Token')).toBe(true);
  const body = (
    spec as unknown as {
      requestBody: { content: Record<string, { schema: { required?: string[] } }> };
    }
  ).requestBody.content['application/json']!.schema;
  expect([...(body.required ?? [])].sort()).toEqual(['expected_row_version', 'permissions']);
  // Test-phase source stays unchanged; the implementer removes just this marker.
  expect(spec['x-implementation']).not.toBe('planned');
});
