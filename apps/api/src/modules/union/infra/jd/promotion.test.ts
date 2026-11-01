import { expect, it } from 'vitest';
import { UnionError, UnionIdentity, type ItemRef } from '../../domain/types.ts';
import { jdIdentityParameters, jdPromotionCodeReq, mapJdConvertResult } from './promotion.ts';

// 合成值，不是录制。规则测试在 test/spec/union/jd-convert/**，这里只补它们没钉的取键细节。
const siteId = '4000123';

class FakeIdentity extends UnionIdentity {
  readonly subUnionId?: unknown;

  constructor(attributes: { readonly subUnionId?: unknown } = {}) {
    super({
      appId: 'fake-app',
      userId: 'fake-user',
      platform: 'jd',
      promotionSlot: '1234567',
      relationId: null,
    });
    if (Object.hasOwn(attributes, 'subUnionId')) this.subUnionId = attributes.subUnionId;
  }
}

function materialOf(item: ItemRef): unknown {
  const req = { item, idempotencyKey: 'fake-key' };
  return jdPromotionCodeReq(req, new FakeIdentity(), siteId)['materialId'];
}

function failure(run: () => unknown): UnionError {
  try {
    run();
  } catch (error) {
    if (error instanceof UnionError) return error;
    throw error;
  }
  throw new Error('expected a UnionError');
}

it.each([
  ['空串', ''],
  ['含斜杠', 'a/b'],
  ['含问号', 'a?b'],
  ['含空格', 'a b'],
  ['含换行', 'a\nb'],
  ['末尾换行', 'ab\n'],
  ['含井号', 'a#b'],
  ['含百分号', 'a%2Fb'],
  ['含反斜杠', 'a\\b'],
  ['含点', '..'],
  ['含全角字符', 'ａｂ'],
  ['不是字符串', 123],
])('[AC-B1-04zd-UNIT#1] itemId 键%s与 item_id 同样 invalid_dto', (_name, value) => {
  for (const key of ['item_id', 'itemId']) {
    const item = { platform: 'jd', [key]: value } as unknown as ItemRef;
    expect(failure(() => materialOf(item))).toMatchObject({ code: 'invalid_dto', platform: 'jd' });
  }
});

it.each([
  ['空串', ''],
  ['含斜杠', 'a/b'],
])('[AC-B1-04zd-UNIT#2] item_id 是%s时不退到 itemId', (_name, item_id) => {
  const item = { platform: 'jd', item_id, itemId: 'goodAseg_Bseg' } as const;
  expect(failure(() => materialOf(item))).toMatchObject({ code: 'invalid_dto' });
});

it('[AC-B1-04zd-UNIT#3] item_id 为 null 时取 itemId', () => {
  expect(materialOf({ platform: 'jd', item_id: null, itemId: 'goodAseg_Bseg' })).toBe(
    'https://jingfen.jd.com/detail/goodAseg_Bseg.html',
  );
});

it('[AC-B1-04zd-UNIT#4] 不是京东商品 → invalid_dto', () => {
  const item = { platform: 'pdd', item_id: 'goodAseg_Bseg' } as const;
  expect(failure(() => materialOf(item))).toMatchObject({ code: 'invalid_dto' });
});

it('[AC-B1-04zd-UNIT#5] subUnionId 为 null 不当 no_rebate → invalid_identity', () => {
  const who = new FakeIdentity({ subUnionId: null });
  expect(failure(() => jdIdentityParameters(who))).toMatchObject({ code: 'invalid_identity' });
});

it('[AC-B1-04zd-UNIT#6] 身份参数不含 userId', () => {
  expect(jdIdentityParameters(new FakeIdentity())).toEqual({ positionId: 1234567 });
});

it.each(['https://', 'https:// union-click.jd.com/x', 'HTTPS://union-click.jd.com/x'])(
  '[AC-B1-04zd-UNIT#7] clickURL %s 不合格 → upstream_unavailable',
  (clickURL) => {
    expect(failure(() => mapJdConvertResult({ data: { clickURL } }))).toMatchObject({
      code: 'upstream_unavailable',
    });
  },
);
