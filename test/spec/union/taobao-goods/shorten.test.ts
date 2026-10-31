import { expect, it } from 'vitest';
import type { UnionErrorCode } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  businessFields,
  ctx,
  endpoint,
  errorBody,
  formOf,
  sent,
  setup,
  SHORT_LINK,
  SPREAD,
  spreadBody,
  unionFailure,
  withStatus,
} from './kit.ts';

const LONG_LINKS = [
  'https://uland.taobao.com/coupon/edetail?e=synthetic-long-0001&pid=synthetic',
  'https://s.click.taobao.com/t?e=synthetic-long-0002',
  'https://ai.taobao.com/search/index.htm?pid=synthetic-long-0003',
  'https://temai.taobao.com/event.htm?pid=synthetic-long-0004',
];
const LONG = 'https://uland.taobao.com/coupon/edetail?e=synthetic-long-0001&pid=synthetic';
/** One spread result, wrapped as recorded (results.tbk_spread[]). */
function one(content: string, errMsg = 'OK'): unknown {
  return spreadBody([{ content, err_msg: errMsg }]);
}

function shortenSetup(answer: unknown = one(SHORT_LINK)) {
  return setup(() => answer);
}

it.each(LONG_LINKS)(
  '[AC-B1-04l#27] 短链：spread.get 的 requests 是 [{url}] 的 JSON 串（%s），返回 content',
  async (link) => {
    const { adapter, transport, credentials } = shortenSetup();
    expect(await adapter.shortenTaobaoUrl(link, ctx)).toBe(SHORT_LINK);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(credentials).toHaveBeenCalledTimes(1);
    const request = sent(transport);
    expect(request).toMatchObject({ platform: 'taobao', method: 'POST', url: endpoint.baseUrl });
    expect(formOf(request)['method']).toBe(SPREAD);
    const fields = businessFields(request);
    expect(Object.keys(fields)).toEqual(['requests']);
    expect(JSON.parse(fields['requests'] ?? 'null')).toEqual([{ url: link }]);
  },
);

it('[AC-B1-04l#28] 短链请求带归档上下文 {appId, kind: convert}，并挂上调用方的 AbortSignal', async () => {
  const { adapter, transport } = shortenSetup();
  const controller = new AbortController();
  await adapter.shortenTaobaoUrl(LONG, { ...ctx, signal: controller.signal });
  const request = sent(transport);
  expect(request.archive).toEqual({ appId: ctx.appId, kind: 'convert' });
  expect(request.signal).toBe(controller.signal);
});

it('[AC-B1-04l#29] 取 results 包装下的第一项', async () => {
  const first = { content: SHORT_LINK, err_msg: 'OK' };
  const second = { content: 'https://s.click.taobao.com/SyNtHeTiCs02', err_msg: 'OK' };
  const { adapter } = shortenSetup(spreadBody([first, second]));
  expect(await adapter.shortenTaobaoUrl(LONG, ctx)).toBe(SHORT_LINK);
});

it.each([
  'http://uland.taobao.com/coupon/edetail?e=synthetic',
  'http://s.click.taobao.com/t?e=synthetic',
  'https://item.taobao.com/item.htm?id=synthetic',
  'https://m.tb.cn/h.synthetic',
  'https://taobao.com/synthetic',
  'https://uland.taobao.com.evil.invalid/coupon',
  'https://evil.invalid/uland.taobao.com/coupon',
  'https://evil.invalid/?to=https://ai.taobao.com/x',
  'ftp://temai.taobao.com/synthetic',
  'not a link',
  '',
])(
  '[AC-B1-04l#30] 不是 https 的 uland / s.click / ai / temai 链接（%s）：invalid_dto，不取凭据、不发请求',
  async (link) => {
    const { adapter, transport, credentials } = shortenSetup();
    await unionFailure(() => adapter.shortenTaobaoUrl(link, ctx), 'invalid_dto');
    expect(credentials).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  },
);

interface ErrorCase {
  readonly name: string;
  readonly answer: unknown;
  readonly code: UnionErrorCode;
}

const spreadErrors: readonly ErrorCase[] = [
  {
    name: 'err_msg 非 OK 且 content 空（已录失败形状）',
    answer: one('', 'synthetic failure'),
    code: 'upstream_rejected',
  },
  {
    name: 'err_msg 为 OK 但 content 空',
    answer: one(''),
    code: 'upstream_rejected',
  },
  {
    name: 'err_msg 非 OK 即使 content 像短链',
    answer: one(SHORT_LINK, 'synthetic failure'),
    code: 'upstream_rejected',
  },
  {
    name: 'content 是 http 短链',
    answer: one('http://s.click.taobao.com/SyNtHeTiCs01'),
    code: 'upstream_unavailable',
  },
  {
    name: 'content 是别的域名',
    answer: one('https://evil.invalid/SyNtHeTiCs01'),
    code: 'upstream_unavailable',
  },
  {
    name: 'content 是仿冒域名',
    answer: one('https://s.click.taobao.com.evil.invalid/x'),
    code: 'upstream_unavailable',
  },
  {
    name: 'code 7（限流）',
    answer: errorBody(7),
    code: 'rate_limited',
  },
  {
    name: 'code 15 + 50001（只有详情细分）',
    answer: errorBody(15, '50001'),
    code: 'upstream_rejected',
  },
  {
    name: 'HTTP 500',
    answer: withStatus(500, 'synthetic outage'),
    code: 'upstream_unavailable',
  },
];

it.each(spreadErrors)('[AC-B1-04l#31] 短链应答 $name 得 $code', async ({ answer, code }) => {
  const { adapter, transport } = shortenSetup(answer);
  await unionFailure(() => adapter.shortenTaobaoUrl(LONG, ctx), code);
  expect(transport).toHaveBeenCalledTimes(1);
});
