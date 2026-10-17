// Stages ⑧ (10005, phone not bound) and ⑨ (30304, not real-name verified) of the request decision
// order (规划/08 BR-ID-01 身份等级 / 判定顺序; task B1-02za, orchestrator rulings §9.3, E19, E21).
// The public entry points follow the frozen rule-test skeleton in test/spec/identity/identity-level/**.
//
// Which level: only the contract's x-auth of the matched route (platform's contractAuthOf, over the
// generated table that includes planned operations). phone → users.phone_hmac must be non-null;
// realname → phone first, then the real-name status must be verified. none / optional / login,
// routes outside the contract and every /v1/agent/ route (BR-AI-23 owns their order) are not judged.
// The subject is the verified token principal (app_id, uid) only: no JWT level claim, no body field.
//
// From the database, uncached: one users read by primary key per judged request, and (realname,
// phone bound) one read of the RealnameStatusReader port. A users row that is missing (also under
// another app_id) fails closed as 10005. A failing read, or no database handle, answers 50001: it
// is never read as "not verified" nor let through.
//
// Where (both paths, between ⑤ and ⑫ / ⑬; RiskModule chains them):
// - non-idempotent operations: the guard, which app.module hands to RiskModule's
//   beforeRateLimitGuards; it skips the contract's x-idempotent operations (judged by the hook);
// - idempotent operations: the post-miss check, which app.module puts first in RiskModule's
//   beforeRateLimit (before ⑫ step-up), reading on the claim's transaction
//   (idempotencyPostMissTransaction()), never a second pooled connection. 10005 is an ordinary
//   refusal (rolled back, no idempotency record: the user binds a phone and retries the key);
//   30304 is a 3xxxx and is stored through platform's StoredRejection, so the key replays it
//   (E21). Outside an HTTP request (jobs, direct calls of the idempotency service) it skips.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no decorators.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  RequestRejection,
  StoredRejection,
  contractAuthOf,
  idempotencyPostMissTransaction,
  tokenPrincipal,
  type ContractAuth,
  type IdempotencyPostMissCheck,
  type TokenPrincipal,
} from '../../platform/index.ts';
import {
  RiskModule,
  contractMinimumVersionRoutes,
  type MinimumVersionRequest,
} from '../../risk/index.ts';

export type RealnameStatus = 'none' | 'verified' | 'failed';

/** Read-only, uncached; the handle is the claim transaction on the post-miss path. */
export interface RealnameStatusReader {
  read(
    handle: Kysely<DB>,
    subject: { readonly app_id: string; readonly user_id: string },
  ): Promise<RealnameStatus>;
}

export interface IdentityLevelInput {
  readonly required: ContractAuth | undefined;
  readonly phoneBound: boolean;
  readonly realnameStatus: RealnameStatus;
}

export interface IdentityLevelGuard {
  canActivate(context: {
    switchToHttp(): { getRequest(): MinimumVersionRequest };
  }): Promise<boolean>;
}

export interface IdentityLevelChecks {
  readonly guard: IdentityLevelGuard;
  readonly postMiss: IdempotencyPostMissCheck;
}

export interface IdentityLevelOptions {
  readonly db: Kysely<DB> | null;
  readonly realname: RealnameStatusReader;
}

/** Nest token of the assembled IdentityLevelChecks (identity.module provides, app.module wires). */
export const IDENTITY_LEVEL_CHECKS = Symbol('IDENTITY_LEVEL_CHECKS');

/** Meanings of contracts/error-codes.yaml. */
const PHONE_REQUIRED_MSG = '需要绑定手机号';
const REALNAME_REQUIRED_MSG = '未实名';
const phoneRequired = () => new RequestRejection(10005, 403, PHONE_REQUIRED_MSG);
const realnameRequired = () => new RequestRejection(30304, 422, REALNAME_REQUIRED_MSG);
const unavailable = () => new RequestRejection(50001, 500, '服务端错误');

/** BR-AI-23: the agent routes judge their own order after ①–⑦; ⑧–⑮ do not apply. */
const AGENT_PREFIX = '/v1/agent/';

/** BR-ID-01: phone before realname; lower auth levels impose neither check. */
export function identityLevelRefusal(input: IdentityLevelInput): null | 10005 | 30304 {
  if (input.required !== 'phone' && input.required !== 'realname') return null;
  if (!input.phoneBound) return 10005;
  if (input.required === 'realname' && input.realnameStatus !== 'verified') return 30304;
  return null;
}

let idempotentRoutes: ReadonlySet<string> | undefined;

/** The contract's x-idempotent operations, `METHOD template` (built once, on first use). */
function isIdempotentRoute(method: string, template: string): boolean {
  idempotentRoutes ??= new Set(
    contractMinimumVersionRoutes()
      .filter((route) => route.idempotent)
      .map((route) => `${route.method} ${route.path}`),
  );
  return idempotentRoutes.has(`${method} ${template}`);
}

/** The level this request's route requires when it is phone or realname; else undefined. */
function judgedLevel(request: MinimumVersionRequest): 'phone' | 'realname' | undefined {
  const template = request.routeOptions.url;
  if (typeof template !== 'string' || template.startsWith(AGENT_PREFIX)) return undefined;
  const auth = contractAuthOf(String(request.method), template);
  return auth === 'phone' || auth === 'realname' ? auth : undefined;
}

/** Contract-driven ⑧⑨; app.module supplies both parts to risk's ordered lists. */
export function createIdentityLevelChecks(options: IdentityLevelOptions): IdentityLevelChecks {
  const { db, realname } = options;

  async function refusalOf(
    handle: Kysely<DB> | null,
    principal: TokenPrincipal | undefined,
    required: 'phone' | 'realname',
  ): Promise<null | 10005 | 30304> {
    // Stage ② has verified a token on every phone / realname route; none here fails closed.
    if (principal === undefined) return 10005;
    if (handle === null) throw unavailable();
    const subject = { app_id: principal.app_id, user_id: principal.uid };
    let phoneBound: boolean;
    try {
      const user = await handle
        .withSchema('app')
        .selectFrom('users')
        .select('phone_hmac')
        .where('app_id', '=', subject.app_id)
        .where('id', '=', subject.user_id)
        .executeTakeFirst();
      phoneBound = user !== undefined && user.phone_hmac !== null;
    } catch {
      throw unavailable();
    }
    let realnameStatus: RealnameStatus = 'none';
    if (phoneBound && required === 'realname') {
      try {
        realnameStatus = await realname.read(handle, subject);
      } catch {
        throw unavailable();
      }
    }
    return identityLevelRefusal({ required, phoneBound, realnameStatus });
  }

  return {
    guard: {
      async canActivate(context) {
        const request = context.switchToHttp().getRequest();
        const required = judgedLevel(request);
        if (required === undefined) return true;
        const template = request.routeOptions.url as string;
        if (isIdempotentRoute(String(request.method).toUpperCase(), template)) return true;
        const refusal = await refusalOf(db, tokenPrincipal(request), required);
        if (refusal === 10005) throw phoneRequired();
        if (refusal === 30304) throw realnameRequired();
        return true;
      },
    },
    async postMiss(command) {
      const request = RiskModule.httpRequestInScope();
      if (request === undefined) return;
      const required = judgedLevel(request);
      if (required === undefined) return;
      const trx = idempotencyPostMissTransaction();
      if (trx === undefined) throw unavailable();
      const refusal = await refusalOf(trx, tokenPrincipal(request), required);
      if (refusal === 10005) throw phoneRequired();
      if (refusal === 30304) {
        throw new StoredRejection(422, {
          code: 30304,
          msg: REALNAME_REQUIRED_MSG,
          trace_id: command.traceId,
        });
      }
    },
  };
}

/**
 * The implementation-stage default must read as none.
 * TODO(规划/11 §2.3): 实名状态读 app.realname — blocked on B1-13d
 */
export function createDefaultRealnameStatusReader(): RealnameStatusReader {
  return { read: () => Promise.resolve('none') };
}
