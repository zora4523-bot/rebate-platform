// B1-02d ruling §9.3 #7–#8: the WeChat and Apple logins are implemented (no x-implementation:
// planned), Huawei stays planned (D21). Red until the orchestrator's mechanical contract commit.
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { apiRequire, ROOT } from '../../risk/signature/kit.ts';

type Operation = { operationId?: string; 'x-implementation'?: string };
async function operations(): Promise<Map<string, Operation>> {
  const parser = apiRequire('@readme/openapi-parser') as {
    parse(path: string): Promise<{ paths: Record<string, { post?: Operation }> }>;
  };
  const document = await parser.parse(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)));
  const found = new Map<string, Operation>();
  for (const [path, item] of Object.entries(document.paths)) {
    if (item.post !== undefined) found.set(path, item.post);
  }
  return found;
}

it('[AC-B1-02d#34] loginByWechat、loginByApple 不再是 planned；华为登录仍是 planned（D21）', async () => {
  const found = await operations();
  for (const [path, operationId] of [
    ['/v1/auth/login/wechat', 'loginByWechat'],
    ['/v1/auth/login/apple', 'loginByApple'],
  ] as const) {
    expect(found.get(path)).toMatchObject({ operationId });
    expect(found.get(path)).not.toHaveProperty('x-implementation');
  }
  expect(found.get('/v1/auth/login/huawei')).toMatchObject({
    operationId: 'loginByHuawei',
    'x-implementation': 'planned',
  });
});
