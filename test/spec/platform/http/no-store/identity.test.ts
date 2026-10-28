// B1-01zzq: which requests carry an identity, and the onSend step on one reply (D10-396 ③).
// Pure: no application, no listener.
import { expect, it } from 'vitest';
import {
  applyNoStore,
  carriesIdentity,
} from '../../../../../apps/api/src/modules/platform/http/no-store.ts';
import {
  APP_HEADERS,
  NO_STORE,
  TRACE,
  adminSession,
  appPrincipal,
  fakeReply,
  h5Principal,
} from './kit.ts';

const identified = [
  { who: 'App 令牌 full', request: { principal: appPrincipal('full') } },
  { who: 'App 令牌 deletion_only', request: { principal: appPrincipal('deletion_only') } },
  { who: 'H5 令牌', request: { principal: h5Principal() } },
  { who: '后台会话', request: { adminPrincipal: adminSession() } },
  { who: '后台超管会话', request: { adminPrincipal: adminSession(true) } },
  {
    who: 'App 令牌与后台会话并存',
    request: { principal: appPrincipal(), adminPrincipal: adminSession() },
  },
  {
    who: '令牌 + 其他请求字段',
    request: { id: TRACE, method: 'GET', headers: { ...APP_HEADERS }, principal: appPrincipal() },
  },
];

const anonymous = [
  { who: '空请求', request: {} },
  { who: '载体为 undefined', request: { principal: undefined, adminPrincipal: undefined } },
  { who: '载体为 null', request: { principal: null, adminPrincipal: null } },
  { who: '载体不是对象', request: { principal: 'uid', adminPrincipal: 1 } },
  {
    who: '只有 Authorization / X-User-Id 请求头',
    request: {
      id: TRACE,
      method: 'GET',
      headers: {
        ...APP_HEADERS,
        authorization: 'Bearer synthetic.unverified.token',
        'x-user-id': '01920000-0000-7000-8000-00000000f011',
        'x-admin-token': 'synthetic-admin-token',
      },
    },
  },
  { who: '只有 verifiedDevice（签名通过、未登录）', request: { verifiedDevice: { appId: 'x' } } },
];

it('[AC-B1-01zzq#1] App / H5 令牌的 principal 与后台会话的 adminPrincipal 都算带身份', () => {
  for (const { who, request } of identified) {
    expect(carriesIdentity(request), who).toBe(true);
  }
});

it('[AC-B1-01zzq#2] 没有已验证载体的请求是匿名的：请求头里的令牌或用户 id 不算身份', () => {
  for (const { who, request } of anonymous) {
    expect(carriesIdentity(request), who).toBe(false);
  }
});

it('[AC-B1-01zzq#3] 带身份、路由没设 Cache-Control：写 no-store，其他响应头不动', () => {
  for (const { who, request } of identified) {
    const r = fakeReply({ 'X-Trace-Id': TRACE, 'content-type': 'application/json' });
    applyNoStore(request, r.reply);
    expect(r.headers, who).toEqual({
      'x-trace-id': TRACE,
      'content-type': 'application/json',
      'cache-control': NO_STORE,
    });
  }
});

it('[AC-B1-01zzq#4] 带身份、路由已设 Cache-Control（任意值、任意大小写）：原值不覆盖', () => {
  const explicit = [
    ['Cache-Control', 'private, max-age=60'],
    ['cache-control', 'public, max-age=300'],
    ['CACHE-CONTROL', 'no-cache'],
    ['Cache-Control', 'no-store'],
  ] as const;
  for (const { who, request } of identified) {
    for (const [name, value] of explicit) {
      const r = fakeReply({ [name]: value, 'x-trace-id': TRACE });
      applyNoStore(request, r.reply);
      expect(r.headers, `${who} / ${name}: ${value}`).toEqual({
        'cache-control': value,
        'x-trace-id': TRACE,
      });
    }
  }
  // Control: the same requests without a route value are answered no-store.
  const r = fakeReply();
  applyNoStore(identified[0]!.request, r.reply);
  expect(r.headers).toEqual({ 'cache-control': NO_STORE });
});

it('[AC-B1-01zzq#5] 匿名请求：不写 Cache-Control，路由自己设的值也原样保留', () => {
  for (const { who, request } of anonymous) {
    const bare = fakeReply({ 'x-trace-id': TRACE });
    applyNoStore(request, bare.reply);
    expect(bare.headers, who).toEqual({ 'x-trace-id': TRACE });
    expect(bare.writes, who).toEqual([]);
    const cached = fakeReply({ 'Cache-Control': 'public, max-age=300' });
    applyNoStore(request, cached.reply);
    expect(cached.headers, who).toEqual({ 'cache-control': 'public, max-age=300' });
  }
  // Control: an identified request on the same bare reply is answered no-store.
  const r = fakeReply({ 'x-trace-id': TRACE });
  applyNoStore({ principal: appPrincipal() }, r.reply);
  expect(r.headers).toEqual({ 'x-trace-id': TRACE, 'cache-control': NO_STORE });
});
