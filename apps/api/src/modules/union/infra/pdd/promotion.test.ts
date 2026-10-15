import { expect, it } from 'vitest';
import { UnionIdentity, type IdentityClaims } from '../../domain/types.ts';
import { unwrapPddResponse } from './response.ts';
import {
  mapAuthorized,
  mapConvertResult,
  pddIdentityParameters,
  PDD_PROMOTION_URL_GENERATE,
} from './promotion.ts';

// Local unit-test identifiers (B1-04h-UNIT); acceptance lives in test/spec/union/pdd-convert.
class UnitIdentity extends UnionIdentity {
  readonly custom_parameters: unknown;
  constructor(parameters: unknown, claims: Partial<IdentityClaims> = {}) {
    super({
      appId: 'unit-app',
      userId: 'unit-user',
      platform: 'pdd',
      promotionSlot: 'unit-pid',
      relationId: null,
      ...claims,
    });
    this.custom_parameters = parameters;
  }
}

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

it('[B1-04h-UNIT#1] custom_parameters 缺失、非扁平文本或推广位为空报 invalid_identity', () => {
  for (const who of [
    new UnitIdentity(undefined),
    new UnitIdentity({ app: 'n', uid: 1 }),
    new UnitIdentity({ app: 'n', nested: { a: 'b' } }),
    new UnitIdentity({ app: 'n' }, { promotionSlot: ' ' }),
    new UnitIdentity({ app: 'n' }, { platform: 'jd' }),
  ]) {
    expect(code(() => pddIdentityParameters(who, 'convert'))).toBe('invalid_identity');
  }
  expect(pddIdentityParameters(new UnitIdentity({ sc: 's', app: 'n' }), 'convert')).toEqual({
    promotionSlot: 'unit-pid',
    customParameters: '{"sc":"s","app":"n"}',
  });
});

it('[B1-04h-UNIT#2] 附加字段丢弃非 https 与脚本 scheme，主地址不受影响', () => {
  const result = mapConvertResult({
    goods_promotion_url_list: [
      {
        mobile_url: 'https://unit.invalid/m',
        schema_url: 'javascript://alert',
        tz_schema_url: 'pinduoduo://unit',
        url: 'http://unit.invalid/plain',
        short_url: 'https://unit.invalid/s',
        we_app_info: { app_id: 'unit' },
      },
    ],
  });
  expect(result).toEqual({
    kind: 'url',
    url: 'https://unit.invalid/m',
    tz_schema_url: 'pinduoduo://unit',
    short_url: 'https://unit.invalid/s',
  });
});

it('[B1-04h-UNIT#3] 备案查询外层不是对象报 upstream_unavailable', () => {
  expect(code(() => mapAuthorized(null))).toBe('upstream_unavailable');
  expect(code(() => mapAuthorized([1]))).toBe('upstream_unavailable');
  expect(mapAuthorized({ bind: 1 })).toBe(true);
});

it('[B1-04h-UNIT#4] 50001 只有带 sub_code 60001 才是业务拒绝', () => {
  const wire = (failure: unknown) => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ error_response: failure }),
  });
  const run = (failure: unknown) =>
    code(() => unwrapPddResponse(PDD_PROMOTION_URL_GENERATE, wire(failure)));
  expect(run({ error_code: 50001, sub_code: 60001 })).toBe('upstream_rejected');
  expect(run({ error_code: '50001', sub_code: '60001' })).toBe('upstream_rejected');
  expect(run({ error_code: 50001, sub_code: 3000000 })).toBe('upstream_unavailable');
  expect(run({ error_code: 50002, sub_code: 60001 })).toBe('upstream_unavailable');
});
