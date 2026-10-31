import { expect, it } from 'vitest';
import {
  ALLOWED_RESULT_KEYS,
  converted,
  COUPON_CLICK_URL,
  ctx,
  dataWithout,
  envelope,
  identity,
  ITEM_URL,
  KUAIZHAN_URL,
  LONG_TPWD,
  privilegeData,
  req,
  response,
  setup,
  SHORT_URL,
  TITLE,
  TPWD,
  unionFailure,
  UPSTREAM_ITEM_ID,
  visible,
} from './kit.ts';

it('[AC-B1-04d#8] 产出 kind=url：url = shortUrl，附带淘口令 / 长淘口令 / 短链 / 领券链接，只有约定的键', async () => {
  const h = setup();
  const result = await converted(() => h.adapter.convert(req, identity, ctx));
  expect(result).toMatchObject({
    kind: 'url',
    url: SHORT_URL,
    tpwd: TPWD,
    long_tpwd: LONG_TPWD,
    short_url: SHORT_URL,
    coupon_click_url: COUPON_CLICK_URL,
  });
  for (const key of Object.keys(result)) {
    expect(ALLOWED_RESULT_KEYS.has(key), `unexpected result key ${key}`).toBe(true);
  }
});

it('[AC-B1-04d#9] 不外露 kuaiZhanUrl、itemUrl、itemId、title 与佣金比例', async () => {
  const h = setup();
  const result = await converted(() => h.adapter.convert(req, identity, ctx));
  const text = visible(result);
  for (const marker of [KUAIZHAN_URL, ITEM_URL, UPSTREAM_ITEM_ID, TITLE, '20.50', '10.50']) {
    expect(text).not.toContain(marker);
  }
  for (const key of [
    'kuaiZhanUrl',
    'kuaizhan_url',
    'itemUrl',
    'item_url',
    'itemId',
    'item_id',
    'title',
    'maxCommissionRate',
    'minCommissionRate',
    'schema_url',
    'mobile_short_url',
    'browser_url',
  ]) {
    expect(result).not.toHaveProperty(key);
  }
});

it.each([
  ['absent', dataWithout('shortUrl')],
  ['null', privilegeData({ shortUrl: null })],
  ['empty', privilegeData({ shortUrl: '' })],
])('[AC-B1-04d#10] shortUrl %s → url 用 couponClickUrl，不带 short_url', async (_label, data) => {
  const h = setup({ reply: response(envelope(data)) });
  const result = await converted(() => h.adapter.convert(req, identity, ctx));
  expect(result.url).toBe(COUPON_CLICK_URL);
  expect(result.coupon_click_url).toBe(COUPON_CLICK_URL);
  expect(result).not.toHaveProperty('short_url');
});

const NOT_HTTPS = [
  'http://s.click.taobao.com/synthetic-plain-http',
  '//s.click.taobao.com/synthetic-protocol-relative',
  'javascript:alert(1)',
  's.click.taobao.com/synthetic-no-scheme',
  'ftp://s.click.taobao.com/synthetic-ftp',
] as const;

it.each(NOT_HTTPS)(
  '[AC-B1-04d#11] 非 https 的 shortUrl（%s）当作没有：url 改用 https 的 couponClickUrl，非 https 值不出现在结果里',
  async (bad) => {
    const h = setup({ reply: response(envelope(privilegeData({ shortUrl: bad }))) });
    const result = await converted(() => h.adapter.convert(req, identity, ctx));
    expect(result.url).toBe(COUPON_CLICK_URL);
    expect(result).not.toHaveProperty('short_url');
    expect(visible(result)).not.toContain(bad);
  },
);

it.each(NOT_HTTPS)(
  '[AC-B1-04d#12] 非 https 的 couponClickUrl（%s）不外露，url 仍是 shortUrl',
  async (bad) => {
    const h = setup({ reply: response(envelope(privilegeData({ couponClickUrl: bad }))) });
    const result = await converted(() => h.adapter.convert(req, identity, ctx));
    expect(result.url).toBe(SHORT_URL);
    expect(result).not.toHaveProperty('coupon_click_url');
    expect(visible(result)).not.toContain(bad);
  },
);

it.each([
  ['both absent', dataWithout('shortUrl', 'couponClickUrl')],
  ['both null', privilegeData({ shortUrl: null, couponClickUrl: null })],
  ['both non-https', privilegeData({ shortUrl: NOT_HTTPS[0], couponClickUrl: NOT_HTTPS[1] })],
  ['both non-string', privilegeData({ shortUrl: 1, couponClickUrl: { url: SHORT_URL } })],
])(
  '[AC-B1-04d#13] shortUrl 与 couponClickUrl %s → upstream_unavailable（kuaiZhanUrl / itemUrl 不顶替）',
  async (_label, data) => {
    const h = setup({ reply: response(envelope(data)) });
    await unionFailure(() => h.adapter.convert(req, identity, ctx), 'upstream_unavailable');
    expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ['absent', dataWithout('tpwd', 'longTpwd')],
  ['null', privilegeData({ tpwd: null, longTpwd: null })],
  ['empty', privilegeData({ tpwd: '', longTpwd: '' })],
  ['non-string', privilegeData({ tpwd: 7, longTpwd: { text: LONG_TPWD } })],
])('[AC-B1-04d#14] tpwd / longTpwd %s → 对应字段省略，链接照常', async (_label, data) => {
  const h = setup({ reply: response(envelope(data)) });
  const result = await converted(() => h.adapter.convert(req, identity, ctx));
  expect(result.url).toBe(SHORT_URL);
  expect(result).not.toHaveProperty('tpwd');
  expect(result).not.toHaveProperty('long_tpwd');
});

it.each([
  ['data absent', { time: 1793500984000, code: 0, msg: 'ok' }],
  ['data null', envelope(null)],
  ['data an array', envelope([privilegeData()])],
  ['data a string', envelope(SHORT_URL)],
  ['data an empty object', envelope({})],
])('[AC-B1-04d#15] %s → upstream_unavailable', async (_label, body) => {
  const h = setup({ reply: response(body) });
  await unionFailure(() => h.adapter.convert(req, identity, ctx), 'upstream_unavailable');
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  expect(h.taobaoTransport).not.toHaveBeenCalled();
});
