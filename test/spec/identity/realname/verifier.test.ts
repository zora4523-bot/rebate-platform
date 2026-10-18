import { expect, it } from 'vitest';

it.each(['local', 'test'])('[AC-B1-13d#20] %s 装配可用的二要素假实现', async (env) => {
  const { createRealnameVerifier } =
    await import('../../../../apps/api/src/modules/identity/infra/fake-realname-verifier.ts');
  const verifier = createRealnameVerifier(env);
  expect(verifier).not.toBeNull();
  const result = await verifier!.verify({
    app_id: 'fixture-app',
    user_id: 'fixture-user',
    name: '测试姓名',
    id_no: '11010519491231002X',
  });
  expect(result).toMatchObject({ outcome: 'match', provider: expect.any(String) });
});

it.each(['staging', 'prod'])('[AC-B1-13d#21] %s 未接供应商不得注入假核验器', async (env) => {
  const { createRealnameVerifier } =
    await import('../../../../apps/api/src/modules/identity/infra/fake-realname-verifier.ts');
  expect(createRealnameVerifier(env)).toBeNull();
});
