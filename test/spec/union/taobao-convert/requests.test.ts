import { expect, it } from 'vitest';
import type {
  ConvertReq,
  UnionIdentity,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  ctx,
  DATAOKE_APP_KEY,
  DATAOKE_SECRET,
  converted,
  expectNothingSent,
  GOODS_ID,
  identity,
  PRIVILEGE_VERSION,
  privilegeRequest,
  RELATION_ID,
  req,
  SELF_SLOT,
  setup,
  SHARE_SLOT,
  TestIdentity,
  unionFailure,
  USER_ID,
} from './kit.ts';

const PUBLIC_KEYS = ['appKey', 'nonce', 'signRan', 'timer', 'version'];

it('[AC-B1-04d#1] 经大淘客 GET get-privilege-link v1.3.1：goodsId 原样、pid = 身份推广位、channelId = relation_id，只走大淘客客户端', async () => {
  const h = setup();
  const signal = new AbortController().signal;
  await converted(() => h.adapter.convert(req, identity, { ...ctx, signal }));
  const { request, fields } = privilegeRequest(h);
  expect(fields).toMatchObject({
    appKey: DATAOKE_APP_KEY,
    version: PRIVILEGE_VERSION,
    goodsId: GOODS_ID,
    pid: SELF_SLOT,
    channelId: RELATION_ID,
  });
  // couponId / specialId / externalId / rebateType 都不带；没有别的业务参数。
  expect(Object.keys(fields).sort()).toEqual(
    [...PUBLIC_KEYS, 'goodsId', 'pid', 'channelId'].sort(),
  );
  expect(request.signal).toBe(signal);
  expect(request.archive).toEqual({ appId: ctx.appId, kind: 'convert' });
  expect(h.dataokeCredentials).toHaveBeenCalledTimes(1);
  expect(h.taobaoCredentials).not.toHaveBeenCalled();
  expect(h.taobaoTransport).not.toHaveBeenCalled();
  for (const marker of [USER_ID, req.idempotencyKey, DATAOKE_SECRET]) {
    expect(request.url).not.toContain(marker);
    expect(JSON.stringify(request.headers)).not.toContain(marker);
  }
});

it.each([
  ['digits beyond the safe integer range', '6543210987654321098765'],
  ['mixed text with separators', 'Ab-12_x9.Z'],
  ['leading zeros', '000123'],
])('[AC-B1-04d#2] goodsId 是 ItemRef.item_id 原样（%s）', async (_label, goodsId) => {
  const h = setup();
  const item: ConvertReq = { item: { platform: 'taobao', item_id: goodsId }, idempotencyKey: 'k' };
  await converted(() => h.adapter.convert(item, identity, ctx));
  expect(privilegeRequest(h).fields.goodsId).toBe(goodsId);
});

it.each([SELF_SLOT, SHARE_SLOT])(
  '[AC-B1-04d#3] pid 取身份里的推广位（%s），union 不另选',
  async (promotionSlot) => {
    const h = setup();
    await converted(() => h.adapter.convert(req, new TestIdentity({ promotionSlot }), ctx));
    const { fields } = privilegeRequest(h);
    expect(fields.pid).toBe(promotionSlot);
    expect(fields.channelId).toBe(RELATION_ID);
  },
);

it('[AC-B1-04d#4] relationId 为 null（linking 判定的 no_rebate 路径）：不带 channelId，仍按推广位转链', async () => {
  const h = setup();
  const who = new TestIdentity({ relationId: null });
  await converted(() => h.adapter.convert(req, who, ctx));
  const { fields } = privilegeRequest(h);
  expect(fields).not.toHaveProperty('channelId');
  expect(fields.pid).toBe(SELF_SLOT);
  expect(fields.goodsId).toBe(GOODS_ID);
  expect(Object.keys(fields).sort()).toEqual([...PUBLIC_KEYS, 'goodsId', 'pid'].sort());
});

it.each([
  ['empty string', ''],
  ['number', 77],
  ['object', { relation: RELATION_ID }],
  ['undefined', undefined],
])(
  '[AC-B1-04d#5] relationId 为%s → invalid_identity，不取凭据、不发请求',
  async (_label, relationId) => {
    const h = setup();
    const who = new TestIdentity({ relationId: relationId as unknown as string | null });
    await unionFailure(() => h.adapter.convert(req, who, ctx), 'invalid_identity');
    expectNothingSent(h);
    // 同一适配器对合格身份照常转链（排除「一律拒绝」）。
    await converted(() => h.adapter.convert(req, identity, ctx));
  },
);

it.each([
  ['a pdd identity', () => new TestIdentity({ platform: 'pdd' })],
  ['an empty promotion slot', () => new TestIdentity({ promotionSlot: '' })],
  ['a blank promotion slot', () => new TestIdentity({ promotionSlot: '   ' })],
  [
    'a forged object with the identity prototype',
    () =>
      Object.assign(Object.create(TestIdentity.prototype) as object, {
        claims: identity.claims,
      }) as UnionIdentity,
  ],
])(
  '[AC-B1-04d#6] %s → invalid_identity，不取凭据、不发请求',
  async (_label, make: () => UnionIdentity) => {
    const h = setup();
    await unionFailure(() => h.adapter.convert(req, make(), ctx), 'invalid_identity');
    expectNothingSent(h);
    await converted(() => h.adapter.convert(req, identity, ctx));
  },
);

it.each([
  ['a pdd item', { platform: 'pdd', item_id: GOODS_ID }],
  ['no item_id', { platform: 'taobao' }],
  ['an empty item_id', { platform: 'taobao', item_id: '' }],
  ['a blank item_id', { platform: 'taobao', item_id: '   ' }],
  ['a null item_id', { platform: 'taobao', item_id: null }],
])('[AC-B1-04d#7] %s → invalid_dto，不取凭据、不发请求', async (_label, item) => {
  const h = setup();
  const bad = { item, idempotencyKey: 'k' } as unknown as ConvertReq;
  await unionFailure(() => h.adapter.convert(bad, identity, ctx), 'invalid_dto');
  expectNothingSent(h);
  await converted(() => h.adapter.convert(req, identity, ctx));
});
