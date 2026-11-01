import { expect, it } from 'vitest';
import { response, unionFailure } from '../jd-core/kit.ts';
import { num } from '../jd-orders/kit.ts';
import { ctx, failure, identity, innerCodes, method, reply, req, warned, wire } from './kit.ts';

// 内层 code 走底座细分表，限流在先；数字 code 与同值字符串同等处理（底座约定）。
const bothForms = innerCodes.flatMap(([code, expected]) => [
  [code, '数字', num(code), expected] as const,
  [code, '字符串', code, expected] as const,
]);
const warnedForms = warned.flatMap((code) => [
  [code, '数字', num(code)] as const,
  [code, '字符串', code] as const,
]);

it.each(bothForms)(
  '[AC-B1-04zd#29] 内层 %s（%s）→ 按表映射，只发一次，不告警',
  async (_code, _form, wireCode, expected) => {
    const h = wire(reply(failure(wireCode)));
    await unionFailure(() => h.adapter.convert(req, identity, ctx), expected);
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.warn).not.toHaveBeenCalled();
  },
);

it.each(warnedForms)(
  '[AC-B1-04zd#30] 内层 %s（%s）→ upstream_rejected 并告警一次，告警只含 method 与 code',
  async (code, _form, wireCode) => {
    const h = wire(reply(failure(wireCode)));
    await unionFailure(() => h.adapter.convert(req, identity, ctx), 'upstream_rejected');
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls).toEqual([[{ method, code }]]);
  },
);

it.each([
  ['网关 code 2', response({ error_response: { code: 2 } }), 'rate_limited'],
  ['网关 code 429', response({ error_response: { code: 429 } }), 'rate_limited'],
  ['网关其他 code', response({ error_response: { code: 19 } }), 'upstream_rejected'],
  ['HTTP 503', response({}, 503), 'upstream_unavailable'],
] as const)('[AC-B1-04zd#31] %s 沿用底座分类', async (_name, answer, expected) => {
  const h = wire(answer);
  await unionFailure(() => h.adapter.convert(req, identity, ctx), expected);
  expect(h.transport).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04zd#32] 传输抛错 → upstream_unavailable', async () => {
  const h = wire();
  h.transport.mockRejectedValue(new Error('synthetic transport failure'));
  await unionFailure(() => h.adapter.convert(req, identity, ctx), 'upstream_unavailable');
});
