// The admin entry's request check (F1-06k; 08 BR-ID-34; 02 §12.1 admin_token, §12.5 whitelist;
// ruling §9.2 #5–#7), installed by bootstrap at the pre-parsing registration point
// (platform/http/request-checks.ts) so that it answers before any body is parsed or validated:
//   1. every request on a /admin/v1 route (the login steps included): the client address
//      (`request.ip`, which only believes X-Forwarded-For behind TRUSTED_PROXIES) must be on the
//      whitelist, else 10403 data.reason=admin_ip_not_allowed — nothing else is read or counted;
//   2. a route whose contract x-auth is admin or super: `Authorization: Bearer <admin_token>` (one
//      header; never a cookie) must verify (HS256 admin key, aud=admin, 8 hours by the Clock), its
//      session must be live in Redis (not logged out, last checked request less than 30 minutes
//      ago by the Clock) and its account active and not locked; else 10001 without data. A
//      passing request records its activity (the idle period restarts) and carries the
//      adminPrincipal. A super route then needs a super account: else 10403
//      data.reason=admin_permission_denied.
// Redis or the database failing is an error (50001), never a pass.
//
// No decorators. The 403 with data is an HttpException (a RequestRejection carries no data), as
// identity's h5 read-only rejection.
import { HttpException } from '@nestjs/common';
import {
  RequestRejection,
  contractAuthOf,
  type Clock,
  type RequestCheck,
  type RequestCheckInput,
} from '../../platform/index.ts';
import { ADMIN_IDLE_TIMEOUT_SEC, isLocked } from '../domain/login-policy.ts';
import type { AdminAccounts } from '../infra/admin-accounts.ts';
import type { AdminSessions } from '../infra/admin-sessions.ts';
import { ADMIN_ACTIVE_STATUS } from './admin-login.ts';
import type { AdminTokens } from './admin-tokens.ts';

/** Fallback texts (clients show their dictionary text error.<code>). */
export const ADMIN_MESSAGES = Object.freeze({
  10001: '请先登录',
  10403: {
    admin_ip_not_allowed: '仅限公司网络访问',
    admin_permission_denied: '当前账号没有这项操作的权限，请联系超级管理员开通',
  },
});

const ADMIN_PREFIX = '/admin/v1/';
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/;
const IDLE_MS = ADMIN_IDLE_TIMEOUT_SEC * 1000;

const marked = new WeakSet<RequestCheck>();

/** True for the check createAdminRequestCheck returns (bootstrap lets admin routes register). */
export function isAdminCheck(check: unknown): boolean {
  return typeof check === 'function' && marked.has(check as RequestCheck);
}

function forbidden(
  reason: keyof (typeof ADMIN_MESSAGES)[10403],
  request: RequestCheckInput,
): HttpException {
  return new HttpException(
    { code: 10403, msg: ADMIN_MESSAGES[10403][reason], data: { reason }, trace_id: request.id },
    403,
  );
}

const unauthenticated = (): RequestRejection =>
  new RequestRejection(10001, 401, ADMIN_MESSAGES[10001]);

export function createAdminRequestCheck(deps: {
  readonly clock: Clock;
  readonly allows: (ip: string | undefined) => boolean;
  readonly tokens: AdminTokens;
  readonly sessions: () => AdminSessions;
  readonly accounts: () => AdminAccounts;
}): RequestCheck {
  const { clock, allows, tokens } = deps;

  const bearer = (request: RequestCheckInput): string | undefined => {
    const header = request.headers['authorization'];
    if (typeof header !== 'string') return undefined;
    return BEARER.exec(header)?.[1];
  };

  const check: RequestCheck = async (request) => {
    const template = request.routeTemplate;
    if (template === undefined || !template.startsWith(ADMIN_PREFIX)) return;
    if (!allows(request.ip)) throw forbidden('admin_ip_not_allowed', request);
    const auth = contractAuthOf(request.method, template);
    if (auth !== 'admin' && auth !== 'super') return;

    const token = bearer(request);
    if (token === undefined) throw unauthenticated();
    const claims = await tokens.verify(token);
    if (claims === null) throw unauthenticated();
    const sessions = deps.sessions();
    const session = await sessions.read(claims.sessionId);
    const now = clock.now().getTime();
    if (
      session === undefined ||
      session.adminId !== claims.adminId ||
      session.appId !== claims.appId ||
      session.expiresAtMs <= now ||
      now - session.lastSeenMs >= IDLE_MS
    ) {
      throw unauthenticated();
    }
    const account = await deps.accounts().byId(claims.appId, claims.adminId);
    if (
      account === undefined ||
      account.status !== ADMIN_ACTIVE_STATUS ||
      isLocked(account.lockedUntil, clock.now())
    ) {
      throw unauthenticated();
    }
    if (!(await sessions.touch(claims.sessionId, { ...session, lastSeenMs: now }))) {
      throw unauthenticated();
    }
    if (auth === 'super' && !account.isSuper) throw forbidden('admin_permission_denied', request);
    request.adminPrincipal = {
      adminId: account.id,
      appId: account.appId,
      sessionId: claims.sessionId,
      isSuper: account.isSuper,
    };
  };
  marked.add(check);
  return check;
}
