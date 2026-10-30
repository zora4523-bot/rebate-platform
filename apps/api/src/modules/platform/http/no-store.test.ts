// Unit tests of the onSend no-store step (B1-01zzq identity rule; B1-15y share page routes).
// Pure: no application, no database, no listener.
import { describe, expect, it } from 'vitest';
import type { AdminPrincipal } from './admin-context.ts';
import { applyNoStore, carriesIdentity, isNoStoreRoute, type NoStoreReply } from './no-store.ts';
import type { TokenPrincipal } from './token-context.ts';

const PAGE = '/v1/share-pages/:link_id';
const TPWD = '/v1/share-pages/:link_id/tpwd';

const PRINCIPAL: TokenPrincipal = {
  uid: '01920000-0000-7000-8000-0000000015a1',
  app_id: 'synthetic_unit',
  sid: 'synthetic-session',
  device_id: '01920000-0000-7000-8000-0000000015a2',
  scp: 'full',
};
const ADMIN: AdminPrincipal = {
  adminId: '01920000-0000-7000-8000-0000000015a3',
  appId: 'couli',
  sessionId: '01920000-0000-7000-8000-0000000015a4',
  isSuper: false,
};

function reply(initial: Record<string, string> = {}) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(initial)) headers[name.toLowerCase()] = value;
  const writes: [string, string][] = [];
  const r: NoStoreReply = {
    hasHeader: (name) => Object.hasOwn(headers, name.toLowerCase()),
    getHeader: (name) => headers[name.toLowerCase()],
    header(name, value) {
      writes.push([name, value]);
      headers[name.toLowerCase()] = value;
      return r;
    },
  };
  return { reply: r, headers, writes };
}

function request(method: string, template: string | undefined, extra: object = {}) {
  return {
    method,
    url: '/concrete',
    routeOptions: template === undefined ? {} : { url: template },
    ...extra,
  };
}

describe('isNoStoreRoute', () => {
  it('[AC-B1-15y] the two share page templates under their own methods are no-store routes', () => {
    expect(isNoStoreRoute('GET', PAGE)).toBe(true);
    expect(isNoStoreRoute('POST', TPWD)).toBe(true);
  });

  it('[AC-B1-15y] HEAD on the GET template is judged as that GET (exposeHeadRoutes); not on the POST one', () => {
    expect(isNoStoreRoute('HEAD', PAGE)).toBe(true);
    expect(isNoStoreRoute('HEAD', TPWD)).toBe(false);
  });

  it('[AC-B1-15y] other methods, templates, concrete URLs and missing templates are not', () => {
    const cases: [string, string | undefined][] = [
      ['POST', PAGE],
      ['GET', TPWD],
      ['PUT', PAGE],
      ['OPTIONS', PAGE],
      ['GET', '/v1/links/:link_id'],
      ['GET', '/v1/share-pages/0199a3b4-5c6d-7000-8000-0000000015f2'],
      ['GET', `${PAGE}/`],
      ['GET', PAGE.toUpperCase()],
      ['GET', ''],
      ['GET', undefined],
      ['HEAD', undefined],
    ];
    for (const [method, template] of cases) {
      expect(isNoStoreRoute(method, template), `${method} ${String(template)}`).toBe(false);
    }
  });
});

describe('applyNoStore', () => {
  it('[AC-B1-15y] anonymous share page request without Cache-Control gets exactly one no-store', () => {
    for (const [method, template] of [
      ['GET', PAGE],
      ['POST', TPWD],
      ['HEAD', PAGE],
    ] as const) {
      const r = reply({ 'x-trace-id': 't' });
      applyNoStore(request(method, template), r.reply);
      expect(r.headers).toEqual({ 'x-trace-id': 't', 'cache-control': 'no-store' });
      expect(r.writes).toEqual([['Cache-Control', 'no-store']]);
    }
  });

  it('[AC-B1-15y] a Cache-Control the share page route set is kept, whatever the name case', () => {
    const r = reply({ 'CACHE-CONTROL': 'no-store' });
    applyNoStore(request('POST', TPWD), r.reply);
    expect(r.headers).toEqual({ 'cache-control': 'no-store' });
    expect(r.writes).toEqual([]);
  });

  it('[AC-B1-15y] other anonymous requests, unmatched routes and requests without routeOptions stay untouched', () => {
    const anonymous: object[] = [
      request('GET', '/v1/links/:link_id'),
      request('POST', PAGE),
      request('GET', undefined),
      { method: 'GET', url: '/v1/share-pages/x' },
      { method: 'GET', routeOptions: null },
      { routeOptions: { url: PAGE } },
      // Request headers that look like a user are not an identity.
      request('GET', '/v1/links/:link_id', { headers: { authorization: 'Bearer x' } }),
    ];
    for (const req of anonymous) {
      expect(carriesIdentity(req)).toBe(false);
      const r = reply();
      applyNoStore(req, r.reply);
      expect(r.headers).toEqual({});
      expect(r.writes).toEqual([]);
    }
  });

  it('[AC-B1-01zzq] identity rule unchanged: default no-store, route-set Cache-Control kept', () => {
    for (const carrier of [{ principal: PRINCIPAL }, { adminPrincipal: ADMIN }]) {
      const req = request('GET', '/v1/links/:link_id', carrier);
      expect(carriesIdentity(req)).toBe(true);
      const bare = reply();
      applyNoStore(req, bare.reply);
      expect(bare.headers).toEqual({ 'cache-control': 'no-store' });
      const own = reply({ 'Cache-Control': 'private, max-age=60' });
      applyNoStore(req, own.reply);
      expect(own.headers).toEqual({ 'cache-control': 'private, max-age=60' });
      expect(own.writes).toEqual([]);
    }
  });
});
