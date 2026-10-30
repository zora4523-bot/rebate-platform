// B1-15y: which routes answer no-store whoever asks, and the onSend step on one reply
// (BR-ATTR-10 细则「缓存」). Pure: no application, no listener. The request objects carry what
// Fastify gives the onSend hook: `method`, the concrete `url` and `routeOptions` (`url` is the
// route template, absent when no route matched).
import { expect, it } from 'vitest';
import {
  applyNoStore,
  isNoStoreRoute,
} from '../../../../../apps/api/src/modules/platform/http/no-store.ts';
import { adminSession, appPrincipal, fakeReply, h5Principal } from '../no-store/kit.ts';
import { LINK, NO_STORE, SHARE_PAGE, SHARE_TPWD, TRACE, pageUrl, tpwdUrl } from './kit.ts';

function routed(method: string, template: string | undefined, url: string, extra: object = {}) {
  return {
    id: TRACE,
    method,
    url,
    routeOptions: template === undefined ? {} : { method, url: template },
    ...extra,
  };
}

const SHARE_ROUTES = [
  ['GET', SHARE_PAGE, pageUrl(LINK)],
  ['POST', SHARE_TPWD, tpwdUrl(LINK)],
] as const;

it('[AC-B1-15y#1] isNoStoreRoute：只有 GET /v1/share-pages/:link_id 与 POST …/:link_id/tpwd 两个路由模板', () => {
  expect(isNoStoreRoute('GET', SHARE_PAGE)).toBe(true);
  expect(isNoStoreRoute('POST', SHARE_TPWD)).toBe(true);
  const others: [string, string | undefined][] = [
    // The same templates under the other operation's or another method.
    ['POST', SHARE_PAGE],
    ['GET', SHARE_TPWD],
    ['PUT', SHARE_PAGE],
    ['DELETE', SHARE_PAGE],
    ['PATCH', SHARE_TPWD],
    // Other anonymous or identified routes.
    ['GET', '/v1/links/:link_id'],
    ['POST', '/v1/links/:link_id/open'],
    ['POST', '/v1/shares'],
    ['GET', '/v1/products/:key'],
    ['GET', '/admin/v1/share-pages/:link_id'],
    // Not the template: a concrete URL, near misses, no template at all.
    ['GET', pageUrl(LINK)],
    ['POST', tpwdUrl(LINK)],
    ['GET', '/v1/share-pages/:link_id/'],
    ['GET', '/v1/share-pages/:id'],
    ['GET', '/v1/share-pages'],
    ['GET', '/v1/share-pages/:link_id/tpwd/extra'],
    ['POST', '/v1/share-pages/:link_id/tpwd/'],
    ['POST', `${SHARE_TPWD}?ticket=x`],
    ['GET', '/V1/SHARE-PAGES/:LINK_ID'],
    ['GET', ` ${SHARE_PAGE}`],
    ['GET', ''],
    ['GET', undefined],
    ['POST', undefined],
  ];
  for (const [method, template] of others) {
    expect(isNoStoreRoute(method, template), `${method} ${String(template)}`).toBe(false);
  }
});

it('[AC-B1-15y#2] 分享中间页两路由的匿名请求：路由没设 Cache-Control 时写 no-store，其他响应头不动', () => {
  for (const [method, template, url] of SHARE_ROUTES) {
    const r = fakeReply({
      'X-Trace-Id': TRACE,
      'content-type': 'application/json; charset=utf-8',
      'retry-after': '30',
    });
    applyNoStore(routed(method, template, url), r.reply);
    expect(r.headers, template).toEqual({
      'x-trace-id': TRACE,
      'content-type': 'application/json; charset=utf-8',
      'retry-after': '30',
      'cache-control': NO_STORE,
    });
  }
  // Request headers that look like a user do not change it: still one no-store.
  const r = fakeReply();
  applyNoStore(
    routed('POST', SHARE_TPWD, tpwdUrl(LINK), {
      headers: { authorization: 'Bearer synthetic.unverified.token', 'x-user-id': TRACE },
    }),
    r.reply,
  );
  expect(r.headers).toEqual({ 'cache-control': NO_STORE });
});

it('[AC-B1-15y#3] 分享中间页两路由：处理器已设的 no-store 原样保留（一个值，不重复、不冲突），带身份时同样', () => {
  const carriers = [
    {},
    { principal: appPrincipal() },
    { principal: h5Principal() },
    { adminPrincipal: adminSession() },
  ];
  for (const [method, template, url] of SHARE_ROUTES) {
    for (const carrier of carriers) {
      const what = `${template} ${Object.keys(carrier).join(',') || 'anonymous'}`;
      const set = fakeReply({ 'Cache-Control': NO_STORE, 'x-trace-id': TRACE });
      applyNoStore(routed(method, template, url, carrier), set.reply);
      expect(set.headers, what).toEqual({ 'cache-control': NO_STORE, 'x-trace-id': TRACE });
      const bare = fakeReply({ 'x-trace-id': TRACE });
      applyNoStore(routed(method, template, url, carrier), bare.reply);
      expect(bare.headers, what).toEqual({ 'cache-control': NO_STORE, 'x-trace-id': TRACE });
    }
  }
});

it('[AC-B1-15y#4] 其他匿名请求仍不加 Cache-Control；带身份请求的既有规则不变（缺省 no-store、路由自设的保留）', () => {
  const anonymous = [
    routed('GET', '/v1/links/:link_id', `/v1/links/${LINK}`),
    routed('POST', '/v1/links/:link_id/open', `/v1/links/${LINK}/open`),
    // The share page URL without a matched route (a 404, or a request object without routeOptions).
    routed('GET', undefined, pageUrl(LINK)),
    { id: TRACE, method: 'POST', url: tpwdUrl(LINK) },
    // The share templates under the wrong method.
    routed('POST', SHARE_PAGE, pageUrl(LINK)),
    routed('GET', SHARE_TPWD, tpwdUrl(LINK)),
  ];
  for (const request of anonymous) {
    const what = `${request.method} ${request.url}`;
    const bare = fakeReply({ 'x-trace-id': TRACE });
    applyNoStore(request, bare.reply);
    expect(bare.headers, what).toEqual({ 'x-trace-id': TRACE });
    expect(bare.writes, what).toEqual([]);
    const cached = fakeReply({ 'Cache-Control': 'public, max-age=300' });
    applyNoStore(request, cached.reply);
    expect(cached.headers, what).toEqual({ 'cache-control': 'public, max-age=300' });
  }

  const identified = routed('GET', '/v1/links/:link_id', `/v1/links/${LINK}`, {
    principal: appPrincipal(),
  });
  const bare = fakeReply();
  applyNoStore(identified, bare.reply);
  expect(bare.headers).toEqual({ 'cache-control': NO_STORE });
  const own = fakeReply({ 'cache-control': 'private, max-age=60' });
  applyNoStore(identified, own.reply);
  expect(own.headers).toEqual({ 'cache-control': 'private, max-age=60' });

  // Control: the share page route itself, anonymous, is answered no-store.
  const control = fakeReply({ 'x-trace-id': TRACE });
  applyNoStore(routed('GET', SHARE_PAGE, pageUrl(LINK)), control.reply);
  expect(control.headers).toEqual({ 'x-trace-id': TRACE, 'cache-control': NO_STORE });
});
