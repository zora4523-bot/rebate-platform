import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { JdAdapterOptions } from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import { jdPromotionCodeReq } from '../../../../apps/api/src/modules/union/infra/jd/promotion.ts';
import { endpoint, expectRedacted, formFields, sent, setup, unionFailure } from '../jd-core/kit.ts';
import {
  clickUrl,
  ctx,
  expectNothingSent,
  firstBody,
  identity,
  itemId,
  JdIdentity,
  materialId,
  method,
  noRebate,
  req,
  siteId,
  slot,
  subUnionId,
  userId,
  wire,
} from './kit.ts';

// D10-500 ①：走 common.get，一个业务对象 promotionCodeReq；bysubunionid.get 不用。
const legalSubUnionId = /^[A-Za-z0-9_-]{1,80}$/;

const missingSite: readonly (readonly [string, Partial<JdAdapterOptions>])[] = [
  ['未给', {}],
  ['null', { siteId: null }],
  ['空串', { siteId: '' }],
];

it('[AC-B1-04zd#1] 一次请求一个 promotionCodeReq：只有 materialId、siteId、positionId、sceneId=1、subUnionId', async () => {
  const h = wire();
  await h.adapter.convert(req, identity, ctx);
  expect(h.transport).toHaveBeenCalledTimes(1);
  expect(h.credentials).toHaveBeenCalledTimes(1);
  const request = sent(h.transport);
  expect(request.url).toBe(endpoint.baseUrl);
  expect(formFields(request)['method']).toBe(method);
  expect(firstBody(h)).toEqual({
    materialId,
    siteId,
    positionId: Number(slot),
    sceneId: 1,
    subUnionId,
  });
});

it('[AC-B1-04zd#2] 不发 pid、ext1、couponUrl、command、protocol；idempotencyKey 与 userId 不上行', async () => {
  const h = wire();
  await h.adapter.convert(req, identity, ctx);
  const body = firstBody(h);
  for (const key of ['pid', 'ext1', 'couponUrl', 'command', 'protocol', 'idempotencyKey']) {
    expect(body).not.toHaveProperty(key);
  }
  const fields = JSON.stringify(formFields(sent(h.transport)));
  expect(fields).not.toContain(req.idempotencyKey);
  expect(fields).not.toContain(userId);
});

it('[AC-B1-04zd#3] siteId 按文档是字符串：超出安全整数也原文上行，不过 number', async () => {
  const site = '9007199254740993';
  const h = wire(undefined, { siteId: site });
  await h.adapter.convert(req, identity, ctx);
  expect(firstBody(h)['siteId']).toBe(site);
  expect(formFields(sent(h.transport))['360buy_param_json']).toContain(`"siteId":"${site}"`);
});

it('[AC-B1-04zd#4] no_rebate：身份没有 subUnionId 属性时请求里没有这个键，不发空串，也不拼 userId', async () => {
  const h = wire();
  const result = await h.adapter.convert(req, noRebate, ctx);
  expect(result).toEqual({ kind: 'url', url: clickUrl });
  expect(firstBody(h)).toEqual({ materialId, siteId, positionId: Number(slot), sceneId: 1 });
  const payload = formFields(sent(h.transport))['360buy_param_json'];
  expect(payload).not.toContain('subUnionId');
  expect(payload).not.toContain(userId);
});

it.each(['n_abcd1234', 'n_abcd1234_k7', 'n_abcd1234-k7', 'N9', 'x', 'x'.repeat(80)])(
  '[AC-B1-04zd#5] 身份的 subUnionId %s 原样上行：适配器不拼不改',
  async (value) => {
    const h = wire();
    await h.adapter.convert(req, new JdIdentity({ subUnionId: value }), ctx);
    expect(firstBody(h)['subUnionId']).toBe(value);
  },
);

it('[AC-B1-04zd#6] 任意合法 subUnionId 原样进请求体', () => {
  expect(() =>
    fc.assert(
      fc.property(fc.stringMatching(legalSubUnionId), (value) => {
        const who = new JdIdentity({ subUnionId: value });
        return jdPromotionCodeReq(req, who, siteId)['subUnionId'] === value;
      }),
      propParams(),
    ),
  ).not.toThrow();
});

it('[AC-B1-04zd#7] 取消信号与归档上下文（kind=convert）挂在传输请求上，归档上下文不上行', async () => {
  const h = wire();
  const signal = new AbortController().signal;
  await h.adapter.convert(req, identity, { ...ctx, signal });
  const request = sent(h.transport);
  expect(request.signal).toBe(signal);
  expect(request.archive).toEqual({ appId: ctx.appId, kind: 'convert' });
  expect(request.body).not.toContain(ctx.appId);
});

it.each(missingSite)(
  '[AC-B1-04zd#8] siteId %s → adapter_unimplemented，不取凭据、不发请求',
  async (_name, overrides) => {
    const h = setup(overrides);
    const error = await unionFailure(
      () => h.adapter.convert(req, identity, ctx),
      'adapter_unimplemented',
    );
    expectNothingSent(h);
    expectRedacted(error, [subUnionId, itemId]);
  },
);
