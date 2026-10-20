import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', root));

it('[AC-B1-13l#1] signLaborAgreement 契约声明 10004 并保留字段校验错误 20001', async () => {
  const parser = requireApi('@readme/openapi-parser') as {
    parse(path: string): Promise<{
      paths: Record<string, { post?: { operationId?: string; 'x-error-codes'?: number[] } }>;
    }>;
  };
  const document = await parser.parse(fileURLToPath(new URL('contracts/openapi.yaml', root)));
  expect(document.paths['/v1/me/labor-agreement/sign']?.post).toMatchObject({
    operationId: 'signLaborAgreement',
    'x-error-codes': expect.arrayContaining([10004, 20001]),
  });
});
