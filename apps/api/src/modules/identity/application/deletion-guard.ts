// Stage ⑥ (10007, account deletion cooling / processing) of the request decision order (规划/08
// BR-ID-01 判定顺序, BR-ID-27; task B1-15e, orchestrator rulings §9.2). The public entry points
// follow the frozen rule-test skeleton in test/spec/identity/deletion-guard/**.
//
// Which requests: method not GET / HEAD and either
// - the contract's x-auth of the matched route is login / phone / realname (platform's
//   contractAuthOf over the generated table, planned operations included), or
// - the route template starts with /v1/agent/ and the request carries a verified token (BR-ID-01
//   「/v1/agent/* 通过 ①–⑦ 后」, BR-ID-27 例「冷静期调 Agent → 10007」; ruling §9.2 #7).
// none, the other optional operations and routes outside the contract are not judged.
// The 10007 whitelist (BR-ID-27, DELETION_WHITELIST below, `METHOD template`) is decided before
// any read; it applies to cooling, processing and done alike (ruling §9.2 #1).
//
// The rule (deletionStageRefusal): the stage of the token's own user (app_id, uid; never the body
// or headers) through identity's deletion-stage reader: none → go on; cooling → 10007
// stage=cooling; processing and done → 10007 stage=processing (the contract's stage enum has no
// done: a leftover session of a finished deletion is refused as processing). A user row missing
// for this app_id reads as none.
//
// From the database, uncached, one reader statement per judged request (stricter than BR-ID-01's
// 60 s cache; no invalidation needed). createDeletionStageChecks({ db: null }) or a failing read
// → 50001, never let through. identity.module assembles the checks without a database
// (deletionStageChecksWithoutDatabase, DB not injected: only APP_ENV=test / local processes
// without a database URL) as not judging, reading nothing: the no-database test mode of the
// other modules' frozen HTTP fixtures (catalog favorites-route, orders pending-tracks), as ⑦
// does without a configuration reader (B1-02zh round 2). Such a process cannot verify a real
// session at ② either (session lookup needs the database), so nothing real is let through.
//
// Where (both paths, after ⑤ and before ⑦; app.module puts them first in RiskModule's lists):
// - non-idempotent operations: the guard (beforeRateLimitGuards) on the pooled db; it skips the
//   contract's x-idempotent operations, judged by the post-miss check;
// - idempotent operations: the post-miss check (beforeRateLimit), reading on the claim's
//   transaction (idempotencyPostMissTransaction()), never a second pooled connection. 10007 is a
//   1xxxx: rolled back, no idempotency record, later checks never run. Outside an HTTP request it
//   skips.
// Both paths refuse with the same contract envelope inside an HttpException (RequestRejection
// carries no data), as ⑦ does.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no decorators.
import { HttpException } from '@nestjs/common';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import {
  RequestRejection,
  contractAuthOf,
  idempotencyPostMissTransaction,
  tokenPrincipal,
  type IdempotencyPostMissCheck,
} from '../../platform/index.ts';
import {
  RiskModule,
  contractMinimumVersionRoutes,
  type MinimumVersionRequest,
} from '../../risk/index.ts';
import { createDeletionStageReader, type DeletionStage } from '../ports/deletion-stage.ts';

export interface DeletionStageChecksOptions {
  /** The pooled database of the guard; null when the process has none (judged routes → 50001). */
  readonly db: Kysely<DB> | null;
}

export interface DeletionStageRefusal {
  readonly code: 10007;
  readonly stage: 'cooling' | 'processing';
}

export interface DeletionStageChecks {
  readonly guard: {
    canActivate(context: {
      switchToHttp(): { getRequest(): MinimumVersionRequest };
    }): Promise<boolean>;
  };
  readonly postMiss: IdempotencyPostMissCheck;
}

/** Nest token of the assembled DeletionStageChecks (identity.module provides, app.module wires). */
export const DELETION_STAGE_CHECKS = Symbol('DELETION_STAGE_CHECKS');

/** contracts/texts.default.json error.10007. */
const DELETION_MSG = '账号注销处理中';

/**
 * BR-ID-27 冷静期 10007 白名单, `METHOD template` (all GET / HEAD are let through before this
 * table). POST /v1/auth/refresh (x-auth none) and POST /v1/consents (optional) are not judged
 * today and are listed so a later x-auth change keeps them through. abandon is let through
 * unconditionally (as ⑤'s whitelist): it grants no right of the original operation (BR-ID-31).
 */
const DELETION_WHITELIST: ReadonlySet<string> = new Set([
  'POST /v1/auth/refresh',
  'POST /v1/auth/logout',
  'POST /v1/consents',
  'POST /v1/me/deletion/cancel',
  'POST /v1/idempotency-keys/abandon',
]);

const AGENT_PREFIX = '/v1/agent/';

const unavailable = () => new RequestRejection(50001, 500, '服务端错误');

function deletionRefused(traceId: string, stage: DeletionStageRefusal['stage']): HttpException {
  return new HttpException(
    { code: 10007, msg: DELETION_MSG, data: { stage }, trace_id: traceId },
    403,
  );
}

/** BR-ID-27: the refusal of one deletion stage, or null when the request goes on. */
export function deletionStageRefusal(stage: DeletionStage): DeletionStageRefusal | null {
  switch (stage) {
    case 'none':
      return null;
    case 'cooling':
      return { code: 10007, stage: 'cooling' };
    case 'processing':
    case 'done':
      return { code: 10007, stage: 'processing' };
  }
}

let idempotentRoutes: ReadonlySet<string> | undefined;

/** The contract's x-idempotent operations, `METHOD template` (built once, on first use). */
function isIdempotentRoute(route: string): boolean {
  idempotentRoutes ??= new Set(
    contractMinimumVersionRoutes()
      .filter((entry) => entry.idempotent)
      .map((entry) => `${entry.method} ${entry.path}`),
  );
  return idempotentRoutes.has(route);
}

/** The request's `METHOD template` when stage ⑥ judges it; else undefined. */
function judgedRoute(request: MinimumVersionRequest): string | undefined {
  const template = request.routeOptions.url;
  if (typeof template !== 'string') return undefined;
  const method = String(request.method).toUpperCase();
  if (method === 'GET' || method === 'HEAD') return undefined;
  const route = `${method} ${template}`;
  if (DELETION_WHITELIST.has(route)) return undefined;
  const auth = contractAuthOf(method, template);
  if (auth === 'login' || auth === 'phone' || auth === 'realname') return route;
  if (
    auth !== undefined &&
    template.startsWith(AGENT_PREFIX) &&
    tokenPrincipal(request) !== undefined
  ) {
    return route;
  }
  return undefined;
}

/** Contract-driven ⑥; app.module supplies both parts to risk's ordered lists. */
export function createDeletionStageChecks(
  options: DeletionStageChecksOptions,
): DeletionStageChecks {
  const { db } = options;

  async function judge(
    request: MinimumVersionRequest,
    handle: Kysely<DB> | Transaction<DB> | null | undefined,
  ): Promise<void> {
    // Stage ② has verified a token on every login-level route; none here fails closed.
    const principal = tokenPrincipal(request);
    if (principal === undefined) throw unavailable();
    if (handle === undefined || handle === null) throw unavailable();
    let stage: DeletionStage;
    try {
      const stages = await createDeletionStageReader({ db: handle }).read(handle, {
        appId: principal.app_id,
        userIds: [principal.uid],
      });
      stage = stages.get(principal.uid) ?? 'none';
    } catch {
      throw unavailable();
    }
    const refusal = deletionStageRefusal(stage);
    if (refusal !== null) throw deletionRefused(request.id, refusal.stage);
  }

  return {
    guard: {
      async canActivate(context) {
        const request = context.switchToHttp().getRequest();
        const route = judgedRoute(request);
        if (route === undefined) return true;
        if (isIdempotentRoute(route)) return true;
        await judge(request, db);
        return true;
      },
    },
    async postMiss() {
      const request = RiskModule.httpRequestInScope();
      if (request === undefined) return;
      if (judgedRoute(request) === undefined) return;
      const trx = idempotencyPostMissTransaction();
      if (trx === undefined) throw unavailable();
      await judge(request, trx);
    },
  };
}

/** identity.module's checks when DB is not injected: not judged, nothing read (see the header). */
export function deletionStageChecksWithoutDatabase(): DeletionStageChecks {
  return {
    guard: {
      async canActivate() {
        return true;
      },
    },
    async postMiss() {},
  };
}
