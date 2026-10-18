// B1-06x: the Pinduoduo filing (备案) pieces shared by the open's check (B1-06v / B1-06z,
// link-open-pdd-auth.ts) and the authorization page refresh (GET /v1/unions/bindings,
// union-bindings-pdd.ts), so both build one identity, ask one port and write one way:
// - pddAuthorityIdentity: the scene's active promotion slot + the user's attr_code → the
//   server-built LinkingUnionIdentity (custom_parameters {app:'n', uid=attr_code, sc}; never a
//   user_id, BR-ID-22). No usable slot or attr_code → a value naming which, logged once.
// - queryPddAuthority: UnionAdapter.queryPddAuthority (an idempotent governed read); missing,
//   failing or a malformed answer → null, logged, nothing written.
// - activatePddBinding: under a savepoint of the caller's transaction, the stored binding judged
//   by canTransitionBinding then written active by a row_version compare-and-set (approvals #26:
//   single entry, single writer linking): the unreleased pending_auth / invalid row in place (its
//   account kept), else a stored `unbound` row, else a new active row of the account used;
//   released history untouched; blocked never overwritten. A write that makes the binding active
//   resolves the user's unresolved pdd conflict rows in the same savepoint, after the write
//   (BR-ID-18; resolveBindingConflictsOnActive takes the (app, user, platform) advisory lock). A
//   concurrent writer winning the unique index or the CAS re-reads and decides on what won.
// B1-19d (BR-ATTR-02, BR-ATTR-07, BR-ID-17): pddAuthorityIdentity takes the account in use; with
// it only that account's active slot builds the identity (none → no_pid, never another account's).
// B1-06za (规划/02 §6.2, §18; D9-4): queryPddAuthority admits at most PDD_QUERY_CONCURRENCY
// queries of this process at once (the open and GET /v1/unions/bindings share the count). A query
// over the cap does not wait: it is refused at once as a failed query (null, logged; the adapter is
// not called) and touches no count; a query that entered frees its one slot when it ends.
// F1-07c: activatePddBinding first takes the user lock (binding-lock.ts) on the caller's
// transaction, outside the per-attempt savepoints (a rollback to one would drop it), and reads the
// risk state after it: a banned user's binding is never written (`banned`, nothing changed). Its
// callers query the union authority before they call it, so the lock is never held across the
// query. A new row's row_version follows the highest of the user's earlier pdd rows.
// F1-07c (BR-ID-20, Codex money review r1): reauthorizationSince tells a binding the console
// left waiting for the user's own authorization — the current row made invalid by enable, or,
// with no current row, the latest released row a reset wrote — by the console's reason on the row
// (only the console writes union_bindings.reason), and since when (the row's updated_at). Until
// the user has been sent through a Pinduoduo authorization link issued after that instant (a pdd
// union_auth_sessions row of the user created at or after it: the open's 30111 auth_jump), neither
// the authorization page refresh nor the open activates the binding from a filing that is still
// valid: the open answers 30111 with a new auth_jump (as for no filing), the refresh writes
// nothing. activatePddBinding judges it only when asked (respectAdminMark: the refresh and the
// open pass it), after the user lock, so a reset / enable committed while the union was queried is
// seen and the stale filing activates nothing; called without it ([AC-F1-07c#17]) it does not.
// TODO(规划/11 §4.5): BR-ID-22 的 (user, pid) 粒度 — blocked on union_bindings 加 pid 维度的迁移
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { newUuidV7, type Clock } from '../../platform/index.ts';
import { canTransitionBinding } from '../domain/binding-status-transitions.ts';
import { resolveBindingConflictsOnActive } from '../infra/binding-conflicts.ts';
import type { AttrCodeReader } from '../ports.ts';
import { LinkingUnionIdentity, type LinkConversionOptions } from './link-open-conversion.ts';
import { attrCodeOf } from './link-registration.ts';
import { UNRELEASED } from './union-auth-reads.ts';
import { lockBindingUser, nextBindingRowVersion, userBannedOn } from './binding-lock.ts';

export const PDD = 'pdd';
const ATTR_CODE = /^[0-9a-z]{8}$/;
const ACTIVATE_ATTEMPTS = 3;
/** Pinduoduo authority queries of this process in flight at once (open + bindings list). */
export const PDD_QUERY_CONCURRENCY = 8;
let pddQueriesInFlight = 0;

type PidScene = Parameters<LinkConversionOptions['pids']['getActivePid']>[0]['pidScene'];
type Warn = LinkConversionOptions['logger'];

export type PddActivation =
  | { readonly kind: 'active'; readonly id: string; readonly accountId: string }
  | { readonly kind: 'blocked' }
  /** F1-07c: the user is banned (read after the user lock); nothing written. */
  | { readonly kind: 'banned' }
  /**
   * F1-07c: asked with respectAdminMark, the binding still waits for the user's own authorization
   * after the console's reset / enable (pddAwaitsReauthorization, read after the user lock).
   */
  | { readonly kind: 'awaits_reauthorization' }
  | { readonly kind: 'retry' };

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === '23505'
  );
}

export interface PddIdentityDeps {
  readonly pids: LinkConversionOptions['pids'];
  readonly attrCodes: AttrCodeReader | undefined;
  readonly logger: Warn;
}

export interface PddIdentityInput {
  readonly appId: string;
  readonly userId: string | null;
  readonly pidScene: string;
  /** B1-19d: the union account in use; omitted, the scene's slot app-wide (as before). */
  readonly unionAccountId?: string;
  readonly traceId: string;
  /** The log event prefix of the caller (`linking.open`, `linking.bindings`). */
  readonly events: string;
}

/** The identity the conversion builds for this scene (link-open-conversion.ts identityFor). */
export async function pddAuthorityIdentity(
  deps: PddIdentityDeps,
  input: PddIdentityInput,
): Promise<LinkingUnionIdentity | 'no_pid' | 'no_attr_code'> {
  const { pids, attrCodes, logger } = deps;
  const { appId, pidScene, traceId, events, unionAccountId } = input;
  const row = await pids.getActivePid({
    appId,
    platform: PDD,
    pidScene: pidScene as PidScene,
    purpose: 'convert',
    ...(unionAccountId === undefined ? {} : { unionAccountId }),
  });
  if (
    row === null ||
    (unionAccountId !== undefined && row.union_account_id !== unionAccountId) ||
    row.status !== 'active' ||
    row.app_id !== appId ||
    row.platform !== PDD ||
    row.pid_scene !== pidScene ||
    row.pid === ''
  ) {
    logger.warn(
      { event: `${events}.no_active_pid`, app_id: appId, platform: PDD, pid_scene: pidScene },
      'linking: no active promotion slot for the pdd authority query',
    );
    return 'no_pid';
  }
  const attrCode = await attrCodeOf(attrCodes, appId, input.userId);
  if (attrCode === null || !ATTR_CODE.test(attrCode)) {
    logger.warn(
      { event: `${events}.attr_code_unavailable`, app_id: appId, platform: PDD, trace_id: traceId },
      'linking: attr_code unavailable for the pdd authority query',
    );
    return 'no_attr_code';
  }
  return new LinkingUnionIdentity({
    appId,
    platform: PDD,
    promotionSlot: row.pid,
    userKey: attrCode,
    customParameters: { app: 'n', uid: attrCode, sc: pidScene },
  });
}

export interface PddQueryDeps {
  readonly registry: LinkConversionOptions['registry'];
  readonly logger: Warn;
}

/** The union authority port; missing, failing or malformed → null (logged, nothing written). */
export async function queryPddAuthority(
  deps: PddQueryDeps,
  input: {
    readonly appId: string;
    readonly identity: LinkingUnionIdentity;
    readonly traceId: string;
    readonly events: string;
  },
): Promise<boolean | null> {
  const { appId, identity, traceId } = input;
  const failed = (error: unknown): null => {
    deps.logger.warn(
      {
        event: `${input.events}.pdd_authority_query_failed`,
        app_id: appId,
        platform: PDD,
        trace_id: traceId,
        error_code: String((error as { code?: unknown } | null)?.code ?? 'unknown'),
      },
      'linking: pdd authority query failed; binding left unchanged',
    );
    return null;
  };
  // Over the cap: refused before any slot is taken, so a refusal never frees another's slot.
  if (pddQueriesInFlight >= PDD_QUERY_CONCURRENCY) return failed({ code: 'concurrency_limit' });
  pddQueriesInFlight += 1;
  try {
    const adapter = deps.registry.get(PDD);
    const query = adapter.queryPddAuthority;
    if (typeof query !== 'function') throw new Error('linking: no pdd authority query');
    const answer = await query.call(adapter, identity, {
      appId,
      requestId: traceId,
      purpose: 'online',
    });
    if (typeof answer?.authorized !== 'boolean') throw new Error('linking: malformed answer');
    return answer.authorized;
  } catch (error) {
    return failed(error);
  } finally {
    pddQueriesInFlight -= 1;
  }
}

export async function pddBindingRows(executor: Kysely<DB>, appId: string, userId: string) {
  return executor
    .selectFrom('union_bindings')
    .select(['id', 'status', 'union_account_id', 'row_version'])
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .where('platform', '=', PDD)
    .execute();
}

interface ReauthorizationRow {
  readonly status: string;
  readonly reason: string | null;
  readonly released_at: Date | null;
  readonly updated_at: Date;
}

/**
 * F1-07c: since when the console has left the user's binding of this platform waiting for the
 * user to authorize again (BR-ID-20: after 恢复返利 / 重置授权 the user authorizes again), or null:
 * the current (unreleased) row is invalid and carries the console's reason, or there is no current
 * row and the latest released row carries it. The instant is that row's updated_at.
 */
export function reauthorizationSince(rows: readonly ReauthorizationRow[]): Date | null {
  const unreleased = rows.find((row) => UNRELEASED.includes(row.status));
  if (unreleased !== undefined) {
    return unreleased.status === 'invalid' && unreleased.reason !== null
      ? unreleased.updated_at
      : null;
  }
  let latest: ReauthorizationRow | undefined;
  for (const row of rows) {
    if (row.status !== 'released') continue;
    if (
      latest === undefined ||
      (row.released_at?.getTime() ?? 0) > (latest.released_at?.getTime() ?? 0)
    ) {
      latest = row;
    }
  }
  return latest !== undefined && latest.reason !== null ? latest.updated_at : null;
}

/**
 * Whether the user's pdd binding still waits for the user's own authorization, read on
 * `executor` now: reauthorizationSince, and no pdd authorization link issued to the user since.
 */
export async function pddAwaitsReauthorization(
  executor: Kysely<DB>,
  appId: string,
  userId: string,
): Promise<boolean> {
  const rows = await executor
    .selectFrom('union_bindings')
    .select(['status', 'reason', 'released_at', 'updated_at'])
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .where('platform', '=', PDD)
    .execute();
  const since = reauthorizationSince(rows);
  if (since === null) return false;
  const issued = await executor
    .selectFrom('union_auth_sessions')
    .select('state')
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .where('platform', '=', PDD)
    .where('mode', '=', 'bind')
    .where('created_at', '>=', since)
    .limit(1)
    .executeTakeFirst();
  return issued === undefined;
}

/** One decision on the rows as read now; writes are conditional (canTransition + CAS). */
async function activateOnce(
  executor: Kysely<DB>,
  now: Date,
  appId: string,
  userId: string,
  accountId: string,
  custom: string,
): Promise<PddActivation> {
  const rows = await pddBindingRows(executor, appId, userId);
  const unreleased = rows.find((row) => UNRELEASED.includes(row.status));
  const stored = unreleased ?? rows.find((row) => row.status === 'unbound');
  if (stored?.status === 'active') {
    return { kind: 'active', id: stored.id, accountId: stored.union_account_id };
  }
  if (stored?.status === 'blocked') return { kind: 'blocked' };
  if (stored !== undefined) {
    // A stored `unbound` row goes through the same single entry (unbound → active).
    if (!canTransitionBinding(stored.status, 'active')) {
      throw new Error(`union_bindings: illegal status transition ${stored.status} → active`);
    }
    // The unreleased row keeps its account (the one this authorization used).
    const account = unreleased === undefined ? accountId : stored.union_account_id;
    const updated = await executor
      .updateTable('union_bindings')
      .set((eb) => ({
        status: 'active',
        union_account_id: account,
        pdd_custom: custom,
        bound_at: eb.fn.coalesce('bound_at', eb.val(now)),
        updated_at: now,
        row_version: eb('row_version', '+', 1),
      }))
      .where('id', '=', stored.id)
      .where('status', '=', stored.status)
      .where('row_version', '=', stored.row_version)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return { kind: 'retry' };
    await resolveBindingConflictsOnActive(executor, appId, userId, PDD, now);
    return { kind: 'active', id: stored.id, accountId: account };
  }
  if (!canTransitionBinding(null, 'active')) {
    throw new Error('union_bindings: illegal status transition (none) → active');
  }
  const id = newUuidV7(now);
  await executor
    .insertInto('union_bindings')
    .values({
      id,
      app_id: appId,
      user_id: userId,
      platform: PDD,
      union_account_id: accountId,
      relation_id: null,
      pdd_custom: custom,
      status: 'active',
      bound_at: now,
      released_at: null,
      cooldown_until: null,
      blocked_reason: null,
      // F1-07c: after the highest row_version of the user's earlier pdd rows.
      row_version: nextBindingRowVersion(rows),
      created_at: now,
      updated_at: now,
    })
    .execute();
  await resolveBindingConflictsOnActive(executor, appId, userId, PDD, now);
  return { kind: 'active', id, accountId };
}

/**
 * Writes the user's pdd binding active (the filing is valid). `executor` must be a transaction:
 * each attempt runs under its own savepoint, so a lost unique race undoes only that attempt and
 * the next one reads what won. Returns active (written now or found), blocked, banned or
 * awaits_reauthorization (nothing written). The user lock is taken first, before any savepoint, and held by the caller's
 * transaction.
 */
export async function activatePddBinding(
  executor: Kysely<DB>,
  clock: Clock,
  input: {
    readonly appId: string;
    readonly userId: string;
    readonly accountId: string;
    readonly custom: string;
    /**
     * F1-07c (BR-ID-20): after the user lock, re-judge pddAwaitsReauthorization; when it holds,
     * nothing is written (`awaits_reauthorization`). The refresh and the open pass true.
     */
    readonly respectAdminMark?: boolean;
  },
): Promise<Exclude<PddActivation, { readonly kind: 'retry' }>> {
  const { appId, userId, accountId, custom } = input;
  if (!(await lockBindingUser(executor, appId, userId))) {
    throw new Error('linking: the pdd binding user does not exist');
  }
  if (await userBannedOn(executor, appId, userId)) return { kind: 'banned' };
  if (
    input.respectAdminMark === true &&
    (await pddAwaitsReauthorization(executor, appId, userId))
  ) {
    return { kind: 'awaits_reauthorization' };
  }
  for (let attempt = 1; ; attempt += 1) {
    let decision: PddActivation;
    await sql`SAVEPOINT pdd_binding_activate`.execute(executor);
    try {
      decision = await activateOnce(executor, clock.now(), appId, userId, accountId, custom);
      await sql`RELEASE SAVEPOINT pdd_binding_activate`.execute(executor);
    } catch (error) {
      await sql`ROLLBACK TO SAVEPOINT pdd_binding_activate`.execute(executor);
      if (!uniqueViolation(error) || attempt >= ACTIVATE_ATTEMPTS) throw error;
      continue;
    }
    if (decision.kind !== 'retry') return decision;
    if (attempt >= ACTIVATE_ATTEMPTS) throw new Error('union_bindings: activation kept losing');
  }
}
