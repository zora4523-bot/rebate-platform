import { expect, it } from 'vitest';
import { classifyBuyType } from '../../../../apps/api/src/modules/orders/domain/attribution.ts';

it.each([
  ['self_buy', 'self'],
  ['agent', 'self'],
  ['share', 'share'],
  ['taolijin', 'self'],
] as const)('[AC-B1-08h#10] 推广位 %s 优先于参数场景', (scene, expected) => {
  for (const platform of ['pdd', 'jd', 'taobao'] as const) {
    expect(classifyBuyType(platform, scene, '{"sc":"share"}')).toEqual({
      buy_type: expected,
      scene_basis: 'pid',
    });
    expect(classifyBuyType(platform, scene, '{"sc":"self_buy"}')).toEqual({
      buy_type: expected,
      scene_basis: 'pid',
    });
  }
});
it.each([
  ['self_buy', 'self'],
  ['agent', 'self'],
  ['share', 'share'],
  ['taolijin', 'self'],
] as const)(
  '[AC-B1-08h#11] fallback 推广位取拼多多 sc=%s，不依赖 uid 有效性',
  (scene, expected) => {
    expect(classifyBuyType('pdd', 'fallback', JSON.stringify({ sc: scene }))).toEqual({
      buy_type: expected,
      scene_basis: 'param',
    });
  },
);
it.each([
  null,
  '',
  'null',
  '[]',
  '{',
  '{}',
  '{"sc":"fallback"}',
  '{"sc":"query"}',
  '{"sc":"SHARE"}',
  '{"sc":1}',
])('[AC-B1-08h#12] 参数无有效场景 %s 时落 self / fallback', (params) => {
  expect(classifyBuyType('pdd', 'fallback', params)).toEqual({
    buy_type: 'self',
    scene_basis: 'fallback',
  });
});
it('[AC-B1-08h#13] query 场景与非拼多多 fallback 不读取 sc', () => {
  expect(classifyBuyType('pdd', 'query', '{"sc":"share"}')).toEqual({
    buy_type: 'self',
    scene_basis: 'fallback',
  });
  for (const platform of ['jd', 'taobao'] as const) {
    expect(classifyBuyType(platform, 'fallback', '{"sc":"share"}')).toEqual({
      buy_type: 'self',
      scene_basis: 'fallback',
    });
  }
});
