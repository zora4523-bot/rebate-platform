import { expect, it } from 'vitest';
import type { UnionIdentity } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { unionFailure } from '../jd-core/kit.ts';
import {
  ctx,
  expectNothingSent,
  firstBody,
  identity,
  JdIdentity,
  materialId,
  req,
  siteId,
  subUnionId,
  wire,
} from './kit.ts';

// BR-ATTR-05：身份只由服务端构造；subUnionId 与推广位都读身份，适配器不补不改。
const forged: readonly (readonly [string, UnionIdentity])[] = [
  ['普通对象', { claims: identity.claims, subUnionId } as unknown as UnionIdentity],
  [
    '只借原型',
    Object.assign(Object.create(JdIdentity.prototype) as object, {
      claims: identity.claims,
      subUnionId,
    }) as unknown as UnionIdentity,
  ],
  ['null', null as unknown as UnionIdentity],
];

const badSubUnionIds: readonly unknown[] = [
  '',
  ' ',
  'n abcd',
  'n.abcd',
  'n+abcd',
  'n/abcd',
  'n_abcd\n',
  '\nn_abcd',
  '汉字',
  'é',
  'x'.repeat(81),
  123,
  ['n_abcd'],
  true,
];

const badSlots: readonly unknown[] = [
  '',
  ' ',
  '0',
  '00',
  '-1',
  '+1',
  '1.5',
  '1.0',
  '1e3',
  '0x10',
  ' 12',
  '12 ',
  '12\n',
  '1 2',
  '１２',
  'abc',
  'synthetic-slot',
  '9007199254740992',
  '9007199254740993',
  '99999999999999999999',
  null,
  undefined,
];

function labelled(values: readonly unknown[]): (readonly [string, unknown])[] {
  return values.map((value) => [JSON.stringify(value) ?? 'undefined', value] as const);
}

it.each(forged)(
  '[AC-B1-04zd#9] %s 不是服务端身份 → invalid_identity，不取凭据、不发请求',
  async (_name, who) => {
    const h = wire();
    await unionFailure(() => h.adapter.convert(req, who, ctx), 'invalid_identity');
    expectNothingSent(h);
  },
);

it.each(['pdd', 'taobao'])(
  '[AC-B1-04zd#10] platform=%s 的身份 → invalid_identity，不取凭据、不发请求',
  async (platform) => {
    const h = wire();
    const who = new JdIdentity(undefined, { platform });
    await unionFailure(() => h.adapter.convert(req, who, ctx), 'invalid_identity');
    expectNothingSent(h);
  },
);

it.each(labelled(badSubUnionIds))(
  '[AC-B1-04zd#11] subUnionId=%s 格式不合 → invalid_identity，不取凭据、不发请求',
  async (_name, value) => {
    const h = wire();
    const who = new JdIdentity({ subUnionId: value });
    await unionFailure(() => h.adapter.convert(req, who, ctx), 'invalid_identity');
    expectNothingSent(h);
  },
);

it.each(labelled(badSlots))(
  '[AC-B1-04zd#12] promotionSlot=%s 不是不超过安全整数的十进制正整数 → invalid_identity',
  async (_name, promotionSlot) => {
    const h = wire();
    const who = new JdIdentity(undefined, { promotionSlot });
    await unionFailure(() => h.adapter.convert(req, who, ctx), 'invalid_identity');
    expectNothingSent(h);
  },
);

it.each([
  ['1', 1],
  ['7654321', 7654321],
  ['9007199254740991', Number.MAX_SAFE_INTEGER],
] as const)(
  '[AC-B1-04zd#13] positionId 取身份的 promotionSlot %s，按文档是 Number',
  async (promotionSlot, positionId) => {
    const h = wire();
    const who = new JdIdentity(undefined, { promotionSlot });
    await h.adapter.convert(req, who, ctx);
    expect(firstBody(h)).toEqual({ materialId, siteId, positionId, sceneId: 1, subUnionId });
  },
);
