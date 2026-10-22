import { expect, it } from 'vitest';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { contract, ROUTE } from './kit.ts';

it('[AC-F1-09r#10] 上传去掉 planned、保留 admin 鉴权、生成路由且无需 step-up', async () => {
  const op = (await contract()).paths[ROUTE]!['post']!;
  expect(op).not.toHaveProperty('x-implementation');
  expect(op).toMatchObject({
    operationId: 'adminUploadPopupAsset',
    'x-auth': 'admin',
    security: [{ adminBearerAuth: [] }],
  });
  expect(op).not.toHaveProperty('x-step-up');
  expect(op.parameters?.map((p) => p.name.toLowerCase()) ?? []).not.toContain('x-step-up-token');
  expect(CONTRACT_ROUTE_SCHEMAS).toHaveProperty('adminUploadPopupAsset');
});
