// B1-06h: POST /v1/unions/{platform}/bindings and GET /v1/unions/bindings (04 §6.3 bindings rows;
// BR-ID-17 细则「授权方式」「授权管理页」「pending_auth 不产生」, BR-ID-19, BR-ID-24 ④).
//
// Submission, in this order (orchestrator ruling D7-3 ②): login (10001) → platform (only taobao
// takes a state and a credential; pdd's body is not in the contract yet, jd has no user
// authorization: 20001 data.fields=[platform]) → platform idempotency (transactional mode) →
// blocked binding of a user who is not banned (30153) → the site authorization of the account this
// authorization uses (30101 / 30102 data.reason=auth_unavailable, same judgement as auth-url) →
// state check ① (exists, this app, taobao, bind, unused, unexpired, uid and device_id match →
// else 30104 without reason) → ②③ (device record's client = state.client, method issued in the
// state and still in union.taobao.auth_methods.<device record's client> → else 30104
// method_not_allowed). None of these touches the state or calls the upstream. Then the state is
// consumed by one conditional UPDATE committed on its own (concurrent submissions: exactly one
// wins, the others 30104), and only then the credential is exchanged with the application the
// state recorded for the method (④: credential_invalid → 30104, state stays used, bindings
// unchanged; an upstream failure → 50001, same). Last, BR-ID-19 decides on the relation id R:
// - another user's active / invalid / blocked row of (app, account, platform, R), or their
//   released row still cooling (cooldown_until > now) → 30151, nothing written (structured warn);
// - the user's unreleased binding: same account and R → active stays untouched, invalid becomes
//   active (bound_at kept); a different R → 30151, never replaced;
// - no unreleased binding: the user's own released row of R still cooling → restored to active
//   (release instants cleared, bound_at kept); otherwise a new active row (bound_at = now).
// The two partial unique indexes stay the arbiter of concurrent writes: a unique violation
// re-reads and decides again (30151 or success), never a 500 and never an application lock.
// Every status written (the new active row, invalid → active, the user's cooling released row →
// active) is first judged by canTransitionBinding (../domain/binding-status-transitions.ts, the
// single entry for union_bindings.status, approvals #26); an existing row's change is then a
// compare-and-set on the row_version read with it; losing it re-reads and decides again.
// TODO(规划/11 §4.5): 换用生成的 transition() — blocked on CT-10 状态机生成器（approvals #26）
//
// Atomicity with the key (Codex money review r1): the submission runs in platform idempotency's
// transactional mode. Everything after the key is claimed reads on that transaction except the
// state consumption, which is one UPDATE on the pool handle committed on its own before the
// exchange (the consumption must be visible before the upstream is called). The binding write and
// the key's completed response then commit together: a binding never takes effect without the
// stored answer, and a stored answer never claims a binding that did not commit. A process that
// dies after the consumption leaves no key record and no binding; the same key then runs again,
// finds its state used and answers 30104 (the state is burnt: the upstream is never called twice
// and the consumption is never rolled back). While the first submission's transaction is open the
// same key gets 40901, as for every transactional operation.
// Each submission holds its transaction's connection while it takes a second one for the
// consumption and the shared reads; BIND_CONCURRENCY keeps those holders below the pool size so
// they can never wait on each other for the last connection.
//
// The credential (code / access_token) lives only in this process: never stored, logged or
// echoed. Responses carry only {platform, status}: no account name, relation id or other user.
// Cross-module reads (devices, user_risk_state, union_accounts, pids) are read-only; this module
// writes union_auth_sessions (used_at only) and union_bindings.
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import {
  newUuidV7,
  type Clock,
  type HandlerResult,
  type Idempotency,
  type RootLogger,
} from '../../platform/index.ts';
import { canTransitionBinding } from '../domain/binding-status-transitions.ts';
import type { CallerContext } from '../ports.ts';
import {
  AuthConfigError,
  UNRELEASED,
  type AuthClient,
  type AuthPlatform,
  type UnionAuthMethod,
  type UnionAuthReads,
} from './union-auth-reads.ts';
import type {
  UnionBindingExchangeInput,
  UnionBindingExchanger,
} from './union-binding-exchanger.ts';

type BindUnionRequest = components['schemas']['BindUnionRequest'];
type BindingRow = Selectable<DB['union_bindings']>;

export interface UnionBindInput {
  /** The path parameter, already checked against the contract's platform enum. */
  readonly platform: string;
  readonly body: BindUnionRequest;
  readonly idempotencyKey: string | undefined;
  readonly traceId: string;
}

export interface UnionBindingsListInput {
  readonly traceId: string;
}

export interface UnionBindingsService {
  bind(input: UnionBindInput): Promise<HandlerResult>;
  list(input: UnionBindingsListInput): Promise<HandlerResult>;
}

export interface UnionBindingsOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly callerContext: CallerContext;
  readonly reads: UnionAuthReads;
  readonly idempotency: Pick<Idempotency, 'executeInTransaction'>;
  readonly exchanger: Pick<UnionBindingExchanger, 'exchange'>;
  readonly logger: Pick<RootLogger, 'warn'>;
}

const CLIENTS: ReadonlySet<string> = new Set<AuthClient>(['ios', 'android', 'harmony']);
/** Platforms of the authorization page (orchestrator ruling D7-3 ⑧: no jd). */
const LISTED: readonly AuthPlatform[] = Object.freeze(['taobao', 'pdd']);
/** Statuses that occupy (app, account, platform, relation_id) for another user (BR-ID-19). */
const OCCUPYING: readonly string[] = Object.freeze([
  'pending_auth',
  'active',
  'invalid',
  'blocked',
]);
/** Unique-violation retries before giving up (each one re-reads and decides again). */
const DECIDE_ATTEMPTS = 4;
/**
 * Submissions of one process that may hold their transaction's connection at once (the api pool
 * has 10, POOL_SIZES.api.db). Each one needs a second connection for the consumption and the
 * shared reads, so this stays well below the pool size; the others wait without a connection.
 */
const BIND_CONCURRENCY = 4;
let bindsRunning = 0;
const bindWaiters: (() => void)[] = [];

async function withBindSlot<T>(run: () => Promise<T>): Promise<T> {
  if (bindsRunning >= BIND_CONCURRENCY) {
    await new Promise<void>((resolve) => bindWaiters.push(resolve));
  } else {
    bindsRunning += 1;
  }
  try {
    return await run();
  } finally {
    // The slot passes straight to the next waiter; the count drops only when nobody waits.
    const next = bindWaiters.shift();
    if (next === undefined) bindsRunning -= 1;
    else next();
  }
}

const STATUS: Readonly<Record<number, number>> = {
  0: 200,
  10001: 401,
  20001: 400,
  30101: 422,
  30102: 422,
  30104: 422,
  30151: 422,
  30153: 422,
  50001: 500,
};

/** Fallback texts only; clients show the dictionary text error.<code> (BR-TEXT-14). */
const MESSAGES: Readonly<Record<number, string>> = {
  0: 'ok',
  10001: '请先登录',
  20001: '参数错误',
  30101: '淘宝暂时无法下单，请稍后再试',
  30102: '淘宝暂时无法下单，请稍后再试',
  30104: '授权已过期，请重新授权',
  30151: '该淘宝账号已绑定本 App 其他用户',
  30153: '该平台返利已被停用，请联系客服',
  50001: '服务端错误',
};

function result(code: number, traceId: string, data?: Record<string, unknown>): HandlerResult {
  return {
    status: STATUS[code] ?? 500,
    envelope: {
      code,
      msg: MESSAGES[code] ?? '服务端错误',
      ...(data === undefined ? {} : { data }),
      trace_id: traceId,
    },
  };
}

/** Throws on a status change the transition table does not allow (never written, 50001). */
function assertTransition(from: string | null, to: string): void {
  if (!canTransitionBinding(from, to)) {
    throw new Error(`union_bindings: illegal status transition ${String(from)} → ${to}`);
  }
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === '23505'
  );
}

/** The credential exactly as the contract branch carries it, without state or method. */
function credentialOf(body: BindUnionRequest): UnionBindingExchangeInput['credential'] {
  return body.auth_method === 'web_code'
    ? { code: body.code }
    : { access_token: body.access_token, expires_in: body.expires_in };
}

type Decision =
  | { readonly kind: 'ok' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'retry' };

export function createUnionBindings(options: UnionBindingsOptions): UnionBindingsService {
  const { db, clock, callerContext, reads, idempotency, exchanger, logger } = options;

  /** BR-ID-19 on relation id R of account A, read once; writes are conditional. */
  async function decide(
    trx: Transaction<DB>,
    appId: string,
    userId: string,
    accountId: string,
    relationId: string,
  ): Promise<Decision> {
    const now = clock.now();
    const platform = 'taobao';
    const others = await trx
      .selectFrom('union_bindings')
      .select(['status', 'cooldown_until'])
      .where('app_id', '=', appId)
      .where('platform', '=', platform)
      .where('union_account_id', '=', accountId)
      .where('relation_id', '=', relationId)
      .where('user_id', '!=', userId)
      .execute();
    const occupied = others.some(
      (row) =>
        OCCUPYING.includes(row.status) ||
        (row.status === 'released' &&
          row.cooldown_until !== null &&
          row.cooldown_until.getTime() > now.getTime()),
    );
    if (occupied) return { kind: 'conflict' };

    const mine: BindingRow[] = await trx
      .selectFrom('union_bindings')
      .selectAll()
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .where('platform', '=', platform)
      .execute();
    const unreleased = mine.find((row) => UNRELEASED.includes(row.status));
    if (unreleased !== undefined) {
      if (unreleased.relation_id !== relationId || unreleased.union_account_id !== accountId) {
        return { kind: 'conflict' };
      }
      if (unreleased.status === 'active') return { kind: 'ok' };
      if (unreleased.status === 'blocked') return { kind: 'blocked' };
      // invalid (or a legacy pending_auth) → active; bound_at is written once and kept.
      assertTransition(unreleased.status, 'active');
      const updated = await trx
        .updateTable('union_bindings')
        .set((eb) => ({
          status: 'active',
          bound_at: eb.fn.coalesce('bound_at', eb.val(now)),
          updated_at: now,
          row_version: eb('row_version', '+', 1),
        }))
        .where('id', '=', unreleased.id)
        .where('status', '=', unreleased.status)
        .where('row_version', '=', unreleased.row_version)
        .executeTakeFirst();
      return updated.numUpdatedRows === 1n ? { kind: 'ok' } : { kind: 'retry' };
    }

    // No unreleased binding: the user's own row of R still cooling is restored (BR-ID-19).
    const cooling = mine
      .filter(
        (row) =>
          row.status === 'released' &&
          row.relation_id === relationId &&
          row.union_account_id === accountId &&
          row.cooldown_until !== null &&
          row.cooldown_until.getTime() > now.getTime(),
      )
      .sort((a, b) => (b.released_at?.getTime() ?? 0) - (a.released_at?.getTime() ?? 0))[0];
    if (cooling !== undefined) {
      assertTransition(cooling.status, 'active');
      const restored = await trx
        .updateTable('union_bindings')
        .set((eb) => ({
          status: 'active',
          released_at: null,
          cooldown_until: null,
          bound_at: eb.fn.coalesce('bound_at', eb.val(now)),
          updated_at: now,
          row_version: eb('row_version', '+', 1),
        }))
        .where('id', '=', cooling.id)
        .where('status', '=', 'released')
        .where('row_version', '=', cooling.row_version)
        .executeTakeFirst();
      return restored.numUpdatedRows === 1n ? { kind: 'ok' } : { kind: 'retry' };
    }

    // pending_auth is never produced (BR-ID-17 细则): the row is written active directly.
    assertTransition(null, 'active');
    await trx
      .insertInto('union_bindings')
      .values({
        id: newUuidV7(now),
        app_id: appId,
        user_id: userId,
        platform,
        union_account_id: accountId,
        relation_id: relationId,
        status: 'active',
        bound_at: now,
        released_at: null,
        cooldown_until: null,
        blocked_reason: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return { kind: 'ok' };
  }

  async function settle(
    trx: Transaction<DB>,
    appId: string,
    userId: string,
    accountId: string,
    relationId: string,
  ): Promise<Decision> {
    for (let attempt = 1; ; attempt += 1) {
      let decision: Decision;
      // A failed statement aborts the transaction: each attempt runs under its own savepoint, so
      // a lost unique race undoes only that attempt and the next one can read what won.
      await sql`SAVEPOINT union_binding_decide`.execute(trx);
      try {
        decision = await decide(trx, appId, userId, accountId, relationId);
        await sql`RELEASE SAVEPOINT union_binding_decide`.execute(trx);
      } catch (error) {
        await sql`ROLLBACK TO SAVEPOINT union_binding_decide`.execute(trx);
        // A concurrent writer won the partial unique index: read again and decide on what won.
        if (!uniqueViolation(error) || attempt >= DECIDE_ATTEMPTS) throw error;
        continue;
      }
      if (decision.kind !== 'retry' || attempt >= DECIDE_ATTEMPTS) return decision;
    }
  }

  async function handle(
    trx: Transaction<DB>,
    appId: string,
    userId: string,
    deviceId: string,
    client: AuthClient,
    body: BindUnionRequest,
    traceId: string,
  ): Promise<HandlerResult> {
    const platform = 'taobao';
    const { status, accountId: bound } = await reads.binding(appId, userId, platform);
    if (status === 'blocked') {
      // A banned user has no session (BR-ID-31); one still reaching here binds nothing either.
      if (await reads.userBanned(appId, userId)) return result(10001, traceId);
      return result(30153, traceId);
    }
    // The account this authorization uses, judged exactly as auth-url judged it (D7-3 ⑦).
    const accountId = await reads.authAccountId(appId, platform, bound);
    if (accountId === null || !(await reads.siteAuthAvailable(appId, platform, accountId))) {
      return result(status === 'invalid' ? 30102 : 30101, traceId, {
        reason: 'auth_unavailable',
      });
    }

    const now = clock.now();
    // ① the state itself: any mismatch is 30104 without reason and leaves it as it is.
    const session = await trx
      .selectFrom('union_auth_sessions')
      .selectAll()
      .where('state', '=', body.state)
      .executeTakeFirst();
    if (
      session === undefined ||
      session.app_id !== appId ||
      session.platform !== platform ||
      session.mode !== 'bind' ||
      session.used_at !== null ||
      session.expire_at.getTime() <= now.getTime() ||
      session.user_id !== userId ||
      session.device_id !== deviceId
    ) {
      return result(30104, traceId);
    }
    // ②③ the device record's client and the method: method_not_allowed, state unchanged.
    const method: UnionAuthMethod = body.auth_method;
    const issued = session.auth_methods ?? [];
    if (
      session.client !== client ||
      !issued.includes(method) ||
      !(await reads.configuredMethods(appId, client)).includes(method)
    ) {
      return result(30104, traceId, { reason: 'method_not_allowed' });
    }
    const refs = session.auth_app_refs as Readonly<Record<string, unknown>> | null;
    const appRef = refs?.[method];
    if (typeof appRef !== 'string' || appRef === '') {
      throw new AuthConfigError('linking: the state recorded no application for the method');
    }

    // Consume: one conditional update on the pool handle, so it commits on its own before the
    // upstream is called (not on trx, which commits only with the key's response).
    const consumed = await db
      .updateTable('union_auth_sessions')
      .set({ used_at: now })
      .where('state', '=', session.state)
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .where('device_id', '=', deviceId)
      .where('used_at', 'is', null)
      .where('expire_at', '>', now)
      .executeTakeFirst();
    if (consumed.numUpdatedRows !== 1n) return result(30104, traceId);

    // ④ with the application the state recorded for this method.
    const exchanged = await exchanger.exchange({
      appId,
      method,
      credential: credentialOf(body),
      appRef,
      traceId,
    });
    if (exchanged.kind === 'credential_invalid') {
      return result(30104, traceId, { reason: 'credential_invalid' });
    }
    if (typeof exchanged.relationId !== 'string' || exchanged.relationId === '') {
      throw new AuthConfigError('linking: the credential exchange returned no relation id');
    }

    const decision = await settle(trx, appId, userId, accountId, exchanged.relationId);
    if (decision.kind === 'conflict') {
      // No conflict log table yet (D7-3 ⑥): a structured warn without R or the other user.
      logger.warn(
        { event: 'linking.bindings.relation_conflict', app_id: appId, user_id: userId, platform },
        'linking: the union relation is held by another binding',
      );
      return result(30151, traceId);
    }
    if (decision.kind === 'blocked') return result(30153, traceId);
    if (decision.kind === 'retry') {
      throw new Error('linking: the binding kept changing under concurrent writers');
    }
    return {
      status: 200,
      envelope: {
        code: 0,
        msg: MESSAGES[0]!,
        data: { platform, status: 'active' },
        trace_id: traceId,
      },
    };
  }

  /** The handler's failures are server faults: logged without the request, answered 50001. */
  async function guarded(traceId: string, run: () => Promise<HandlerResult>) {
    try {
      return await run();
    } catch (error) {
      logger.warn(
        {
          event: 'linking.bindings.failed',
          error_name: error instanceof Error ? error.name : typeof error,
        },
        'linking: binding submission failed',
      );
      return result(50001, traceId);
    }
  }

  return {
    async bind(input) {
      const { traceId } = input;
      const caller = await callerContext.current();
      if (caller.userId === null || caller.deviceId === null) return result(10001, traceId);
      const { appId, userId, deviceId } = caller;
      if (input.platform !== 'taobao') {
        return result(20001, traceId, { fields: ['platform'] });
      }
      // The client is the device record's (BR-ID-17 细则), never the X-Platform declaration.
      const device = await db
        .selectFrom('devices')
        .select(['platform', 'revoked_at'])
        .where('app_id', '=', appId)
        .where('id', '=', deviceId)
        .executeTakeFirst();
      if (device === undefined || device.revoked_at !== null) return result(10001, traceId);
      if (!CLIENTS.has(device.platform)) return result(50001, traceId);
      const client = device.platform as AuthClient;

      const response = await withBindSlot(() =>
        idempotency.executeInTransaction(
          {
            appId,
            actor: { userId, deviceId, phoneHmac: null },
            method: 'POST',
            path: `/v1/unions/${input.platform}/bindings`,
            key: input.idempotencyKey,
            body: input.body,
            traceId,
          },
          (trx) =>
            guarded(traceId, () =>
              handle(trx, appId, userId, deviceId, client, input.body, traceId),
            ),
        ),
      );
      // Handler and replay alike: the stored body is the answer, so a replay equals the first.
      return {
        status: response.status,
        envelope: JSON.parse(response.body) as HandlerResult['envelope'],
      };
    },

    async list(input) {
      const caller = await callerContext.current();
      if (caller.userId === null) return result(10001, input.traceId);
      const { appId, userId } = caller;
      const items = [];
      for (const platform of LISTED) {
        // Pinduoduo's self-purchase slot authorization has no pid_scene column on bindings: the
        // same projection of its platform row (D7-3 ⑨).
        const { status } = await reads.binding(appId, userId, platform);
        items.push({ platform, status });
      }
      return {
        status: 200,
        envelope: { code: 0, msg: MESSAGES[0]!, data: { items }, trace_id: input.traceId },
      };
    },
  };
}
