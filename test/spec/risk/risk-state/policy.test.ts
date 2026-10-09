import { expect, it } from 'vitest';
import { BANNED, NORMAL, SUBJECT, WHITELIST, policyFixture, request } from './policy-kit.ts';

for (const state of ['banned', 'appealing'] as const) {
  for (const route of WHITELIST) {
    it(`[AC-B1-03h#1][BR-ID-31/36] ${state} 白名单 ${route.method} ${route.path}`, async () => {
      const f = policyFixture({ ...BANNED, state });
      try {
        await expect(f.service().checkRequest(request(route))).resolves.toBeUndefined();
      } finally {
        await f.db.destroy();
      }
    });
  }
}

const BLOCKED = [
  { method: 'GET', path: '/v1/products/search' },
  { method: 'POST', path: '/v1/consents', body: { type: 'privacy', accepted: false } },
  { method: 'POST', path: '/v1/links/:link_id/open' },
  { method: 'POST', path: '/v1/withdrawals' },
  { method: 'PUT', path: '/v1/me/payout-account' },
  { method: 'POST', path: '/v1/me/phone' },
  { method: 'POST', path: '/v1/auth/oauth-attempts', body: { purpose: 'login' } },
  {
    method: 'POST',
    path: '/v1/auth/oauth-attempts',
    body: { purpose: 'payout_bind', action: 'account_deletion' },
  },
  {
    method: 'POST',
    path: '/v1/auth/oauth-attempts',
    body: { purpose: 'step_up', action: 'withdraw' },
  },
  { method: 'POST', path: '/v1/auth/oauth-attempts', body: { action: 'account_deletion' } },
  { method: 'POST', path: '/v1/auth/step-up', body: { action: 'withdraw' } },
  { method: 'POST', path: '/v1/auth/step-up', body: {} },
  { method: 'POST', path: '/v1/auth/step-up', body: { nested: { action: 'account_deletion' } } },
  { method: 'POST', path: '/v1/me' },
  { method: 'POST', path: '/v1/withdrawals/:withdrawal_id' },
  { method: 'GET', path: '/v1/withdrawals/:withdrawal_id/extra' },
];
for (const state of ['banned', 'appealing'] as const) {
  for (const route of BLOCKED) {
    it(`[AC-B1-03h#2][BR-ID-31/36] ${state} 不扩大白名单 ${route.method} ${route.path} ${JSON.stringify(route.body)}`, async () => {
      const f = policyFixture({ ...BANNED, state });
      try {
        const r = request(route);
        await expect(f.service().checkRequest(r)).rejects.toMatchObject({
          response: { code: 10006, trace_id: r.id },
          status: 403,
        });
      } finally {
        await f.db.destroy();
      }
    });
  }
}

for (const snapshot of [
  null,
  NORMAL,
  { ...BANNED, state: 'frozen' as const },
  { ...BANNED, state: 'appealing' as const },
]) {
  it(`[AC-B1-03h#3][BR-ID-36] ${snapshot?.state ?? '无行'}，申诉前 frozen，不作封禁拦截`, async () => {
    const f = policyFixture(snapshot, 'frozen');
    try {
      await expect(
        f.service().checkRequest(request({ method: 'POST', path: '/v1/withdrawals' })),
      ).resolves.toBeUndefined();
    } finally {
      await f.db.destroy();
    }
  });
}

for (const path of [
  '/v1/auth/login/sms',
  '/v1/auth/login/wechat',
  '/v1/auth/login/apple',
  '/v1/auth/login/huawei',
  '/v1/products/search',
]) {
  it(`[AC-B1-03h#4][BR-ID-31] 无 principal ${path} 不查风控库，也不从请求头借用身份`, async () => {
    const f = policyFixture();
    try {
      const r = request({ method: path.endsWith('search') ? 'GET' : 'POST', path }, false);
      await expect(
        f.service().checkRequest({
          ...r,
          headers: {
            ...r.headers,
            authorization: 'Bearer untrusted',
            'x-user-id': SUBJECT.user_id,
          },
        }),
      ).resolves.toBeUndefined();
      expect(f.reads).toHaveLength(0);
    } finally {
      await f.db.destroy();
    }
  });
}
