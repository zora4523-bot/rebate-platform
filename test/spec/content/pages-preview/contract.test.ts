import { expect, it } from 'vitest';
import { contract } from '../../risk/signature/kit.ts';

it('[AC-F1-09e#17] 两个预览接口解除 planned，公开预览仍为无用户鉴权和无请求签名', async () => {
  const document = await contract();
  const issue = document.paths['/admin/v1/pages/{page_key}/preview-tokens']?.post;
  const preview = document.paths['/v1/pages/{page_key}/preview']?.get;
  expect(issue).toBeDefined();
  expect(preview).toBeDefined();
  expect(issue).not.toHaveProperty('x-implementation', 'planned');
  expect(preview).not.toHaveProperty('x-implementation', 'planned');
  expect(issue).toMatchObject({ operationId: 'adminCreatePagePreviewToken', 'x-auth': 'admin' });
  expect(preview).toMatchObject({
    operationId: 'previewPage',
    'x-auth': 'none',
    'x-signed': false,
    security: [],
  });
});
