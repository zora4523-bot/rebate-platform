import { expect, it } from 'vitest';
import { searchProductsDefinition } from '../../../../apps/api/src/modules/agent/tools/search/schema.ts';
import { candidate, effectiveValues, fixture, keys, portPage } from './kit.ts';

it('[AC-B3-04e#1] 参数表声明可选 spec/page 的类型和上限，仍只要求 q 且禁止额外参数与身份字段', () => {
  const definition = searchProductsDefinition(['taobao', 'jd', 'pdd']);
  expect(definition.parameters).toMatchObject({
    type: 'object',
    required: ['q'],
    additionalProperties: false,
    properties: {
      spec: { type: 'string', minLength: 1, maxLength: 50 },
      page: { type: 'integer', minimum: 1, maximum: 5 },
    },
  });
  const schema = definition.parameters as {
    required: unknown;
    properties: Record<string, unknown>;
  };
  expect(schema.required).toEqual(['q']);
  const identity = [
    'user_id',
    'uid',
    'app_id',
    'device_id',
    'scene',
    'pid',
    'p_id',
    'adzone_id',
    'site_id',
    'position_id',
    'relation_id',
    'special_id',
    'sub_union_id',
    'custom_parameters',
    'union_id',
  ].map((key) => key.replaceAll('_', ''));
  expect(
    Object.keys(schema.properties).filter((key) =>
      identity.includes(key.toLowerCase().replace(/[_-]/gu, '')),
    ),
  ).toEqual([]);
});

it.each([
  { label: '省略', args: {}, page: 1 },
  { label: '显式第一页', args: { page: 1 }, page: 1 },
  { label: '第三页', args: { page: 3 }, page: 3 },
  { label: '上限第五页', args: { page: 5 }, page: 5 },
])('[AC-B3-04e#2] $label：每个开启平台都收到同一实际页号', async ({ args, page }) => {
  const h = fixture();
  expect((await h.execute({ q: '牛奶', ...args })).kind).toBe('ok');
  expect(h.searchProducts.mock.calls.map(([query]) => query.platform).toSorted()).toEqual([
    'jd',
    'pdd',
    'taobao',
  ]);
  expect(h.searchProducts.mock.calls.map(portPage)).toEqual([page, page, page]);
});

it('[AC-B3-04e#3] 页号随本次参数传递，不跨调用或按平台自行递增，省略时重新用第一页', async () => {
  const h = fixture();
  h.settings.set('search.enabled.pdd', false);
  for (const args of [{ page: 3 }, { page: 4 }, { page: 4 }, {}]) {
    h.searchProducts.mockClear();
    expect((await h.execute({ q: '牛奶', ...args })).kind).toBe('ok');
    expect(h.searchProducts.mock.calls.map(([query]) => query.platform).toSorted()).toEqual([
      'jd',
      'taobao',
    ]);
    expect(h.searchProducts.mock.calls.map(portPage)).toEqual([args.page ?? 1, args.page ?? 1]);
  }
});

it('[AC-B3-04e#4] spec 不拼入上游 q，注册表原样接收规格词', async () => {
  const h = fixture();
  const args = { q: '牛奶', spec: '24盒' };
  expect((await h.execute(args)).kind).toBe('ok');
  expect(h.run).toHaveBeenCalledWith(args, expect.anything());
  expect(h.searchProducts.mock.calls.map(([query]) => query.q)).toEqual(['牛奶', '牛奶', '牛奶']);
  expect(args).toEqual({ q: '牛奶', spec: '24盒' });
});

it('[AC-B3-04e#5] 相同候选有无 spec 的出卡集合及顺序相同，标题不符或未知规格仍保留', async () => {
  const h = fixture([
    candidate('tb:synthetic-a', '合成牛奶 12盒', 'taobao'),
    candidate('tb:synthetic-b', '合成牛奶 24盒', 'taobao'),
    candidate('jd:synthetic-c', '合成牛奶', 'jd'),
    candidate('pdd:synthetic-d', '合成牛奶 500ml', 'pdd'),
  ]);
  const baseline = keys(await h.execute({ q: '牛奶' }));
  expect(baseline.toSorted()).toEqual([
    'jd:synthetic-c',
    'pdd:synthetic-d',
    'tb:synthetic-a',
    'tb:synthetic-b',
  ]);
  for (const spec of ['24盒', '完全不匹配的合成规格']) {
    expect(keys(await h.execute({ q: '牛奶', spec }))).toEqual(baseline);
  }
});

it.each([
  { spec: '24盒', page: 3 },
  { spec: ' 500ml × 24盒 ', page: 5 },
])(
  '[AC-B3-04e#6] 生效条件供编排读取且规格原样保留，模型只获商品摘要：$spec / $page',
  async ({ spec, page }) => {
    const h = fixture([candidate('tb:synthetic-a', '合成牛奶', 'taobao')]);
    const outcome = await h.execute({ q: '牛奶', spec, page });
    expect(outcome.kind).toBe('ok');
    expect(effectiveValues(outcome, 'spec')).toContain(spec);
    expect(effectiveValues(outcome, 'page')).toContain(page);
    expect(outcome.modelView).toEqual({
      items: [
        {
          card_id: 'c12',
          title: '<untrusted>合成牛奶</untrusted>',
          platform: 'taobao',
          benefit_tags: [],
        },
      ],
    });
  },
);

it('[AC-B3-04e#7] 空结果仍暴露本次生效条件；后续省略参数不能残留上轮 spec/page', async () => {
  const h = fixture();
  const first = await h.execute({ q: '牛奶', spec: '24盒', page: 3 });
  expect(first.kind).toBe('ok');
  expect(effectiveValues(first, 'spec')).toContain('24盒');
  expect(effectiveValues(first, 'page')).toContain(3);
  expect(first.modelView).toEqual({ items: [] });
  const next = await h.execute({ q: '牛奶' });
  expect(next.kind).toBe('ok');
  expect(effectiveValues(next, 'page')).toContain(1);
  expect(
    effectiveValues(next, 'spec').filter((value) => value !== null && value !== undefined),
  ).toEqual([]);
  expect(next.modelView).toEqual({ items: [] });
});

// 每个拒绝案例都带同字段合法对照，旧 schema 拒绝一切新字段不能冒充正确校验。
it.each([
  { label: '空规格', invalid: { spec: '' }, valid: { spec: '盒' } },
  { label: '51字符规格', invalid: { spec: '盒'.repeat(51) }, valid: { spec: '盒'.repeat(50) } },
  { label: '非字符串规格', invalid: { spec: 24 }, valid: { spec: '24盒' } },
  { label: '空值规格', invalid: { spec: null }, valid: { spec: '24盒' } },
  { label: '第零页', invalid: { page: 0 }, valid: { page: 1 } },
  { label: '第六页', invalid: { page: 6 }, valid: { page: 5 } },
  { label: '小数页号', invalid: { page: 1.5 }, valid: { page: 2 } },
  { label: '字符串页号', invalid: { page: '3' }, valid: { page: 3 } },
  { label: '空值页号', invalid: { page: null }, valid: { page: 3 } },
  {
    label: '额外字段',
    invalid: { spec: '24盒', page: 3, unknown: true },
    valid: { spec: '24盒', page: 3 },
  },
])('[AC-B3-04e#8] $label 被注册表拒绝且不检索，合法对照可执行', async ({ invalid, valid }) => {
  const h = fixture();
  expect(await h.execute({ q: '牛奶', ...invalid })).toEqual({
    kind: 'rejected',
    modelView: { error: 'invalid_args' },
  });
  expect(h.run).not.toHaveBeenCalled();
  expect(h.searchProducts).not.toHaveBeenCalled();
  expect((await h.execute({ q: '牛奶', ...valid })).kind).toBe('ok');
  expect(h.run).toHaveBeenCalledTimes(1);
  expect(h.searchProducts).toHaveBeenCalledTimes(3);
});
