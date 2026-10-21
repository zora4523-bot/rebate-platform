import { expect, it } from 'vitest';
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { PATH, contract } from './kit.ts';

it.each([
  [PATH, 'adminListClaims'],
  [`${PATH}/{claim_id}`, 'adminGetClaim'],
])('[AC-B1-10j#27] %s 移除 planned，保留后台鉴权', async (path, operationId) => {
  const operation = (await contract()).paths[path]?.get;
  expect(operation).toBeDefined();
  expect(operation?.['x-implementation']).not.toBe('planned');
  expect(operation).toMatchObject({ operationId, 'x-auth': 'admin' });
});

it('[AC-B1-10j#28] 历史记录 scene 必填但可空，未知渠道值和额外原始数据仍不合法', async () => {
  const check = createValidatorCompiler()({
    schema: (await contract()).components.schemas['AdminClaimEvidenceLink']!,
    httpPart: 'body',
  });
  const at = '2026-10-05T01:00:00.000Z';
  expect(check({ at, scene: null })).toBe(true);
  expect(check({ at, scene: 'detail' })).toBe(true);
  expect(check({ at })).toBe(false);
  expect(check({ at, scene: 'unknown' })).toBe(false);
  expect(check({ at, scene: 'detail', product_key: 'jd:secret' })).toBe(false);
});
