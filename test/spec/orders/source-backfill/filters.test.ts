import { expect, it } from 'vitest';
import {
  matchOrderSource,
  type LinkLogCandidate,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { at, input, log, matched, NONE } from './kit.ts';

const rejected: { name: string; patch: Partial<LinkLogCandidate> }[] = [
  { name: '他人身份', patch: { user_id: 'other' } },
  { name: '空身份', patch: { user_id: null } },
  { name: '其他平台', patch: { platform: 'jd' } },
  { name: '空平台', patch: { platform: null } },
  { name: 'precompute', patch: { event: 'precompute' } },
  { name: 'register', patch: { event: 'register' } },
  { name: '非零结果', patch: { result_code: 1 } },
  { name: '空结果', patch: { result_code: null } },
  { name: '不同推广位场景', patch: { pid_scene: 'self_buy' } },
  { name: '空推广位场景', patch: { pid_scene: null } },
  { name: '窗前一秒', patch: { created_at: at('2026-10-05T11:59:59+08:00') } },
  { name: '窗后一秒', patch: { created_at: at('2026-10-20T12:00:01+08:00') } },
];

it.each(rejected)('[AC-B1-08j#10] product 和 shop 都排除 $name', ({ patch }) => {
  for (const productKey of ['pdd:123', null]) {
    expect(matchOrderSource(input({ productKey, candidates: [log(patch)] }))).toEqual(NONE);
    const valid = log({ created_at: at('2026-10-06T13:14:15+08:00'), link_id: 'valid' });
    expect(matchOrderSource(input({ productKey, candidates: [log(patch), valid] }))).toEqual(
      matched(valid, productKey === null ? 'shop' : 'product'),
    );
  }
});

it.each(['convert', 'open'])('[AC-B1-08j#11] %s 成功是点击证据', (event) => {
  const row = log({ event });
  expect(matchOrderSource(input({ candidates: [row] }))).toEqual(matched(row));
});

it.each(['self_buy', 'query', null])(
  '[AC-B1-08j#12] fallback 不限制候选 pid_scene=%s',
  (pid_scene) => {
    const row = log({ pid_scene });
    expect(matchOrderSource(input({ pidScene: 'fallback', candidates: [row] }))).toEqual(
      matched(row),
    );
  },
);

it('[AC-B1-08j#13] query 按字面匹配，不退化成 fallback', () => {
  const query = log({ pid_scene: 'query', scene: 'search' });
  expect(matchOrderSource(input({ pidScene: 'query', candidates: [query] }))).toEqual(
    matched(query),
  );
  expect(matchOrderSource(input({ pidScene: 'query' }))).toEqual(NONE);
});

it.each([
  ['2026-10-05T12:00:00+08:00', true],
  ['2026-10-05T11:59:59+08:00', false],
  ['2026-10-05T11:59:59.999+08:00', false],
  ['2026-10-20T12:00:00+08:00', true],
  ['2026-10-20T12:00:01+08:00', false],
  ['2026-10-20T12:00:00.001+08:00', false],
] as const)('[AC-B1-08j#14] 360 小时闭区间边界 %s，命中=%s', (time, included) => {
  const row = log({ created_at: at(time) });
  expect(matchOrderSource(input({ candidates: [row] }))).toEqual(included ? matched(row) : NONE);
});

it('[AC-B1-08j#15] windowHours 配置生效，按绝对小时而非自然日', () => {
  const row = log({ created_at: at('2026-10-19T04:00:00Z') });
  expect(matchOrderSource(input({ windowHours: 24, candidates: [row] }))).toEqual(matched(row));
  expect(matchOrderSource(input({ windowHours: 23, candidates: [row] }))).toEqual(NONE);
  const acrossDst = log({ created_at: at('2026-11-01T00:30:00-04:00') });
  expect(
    matchOrderSource(
      input({ attrAt: at('2026-11-02T00:30:00-05:00'), windowHours: 24, candidates: [acrossDst] }),
    ),
  ).toEqual(NONE);
});

it('[AC-B1-08j#16] 只有商品为空时跳 product，仍可 shop；只有店铺为空仍可 product', () => {
  expect(matchOrderSource(input({ productKey: null }))).toEqual(matched(log(), 'shop'));
  expect(matchOrderSource(input({ shopId: null }))).toEqual(matched(log()));
});

it.each(['no_rebate', 'expired', 'cache_hit'] as const)(
  '[AC-B1-08j#40] open 成功记录的 %s 标记不取消点击证据',
  (flag) => {
    const row = { ...log(), [flag]: true };
    expect(matchOrderSource(input({ candidates: [row] }))).toEqual(matched(row));
  },
);
