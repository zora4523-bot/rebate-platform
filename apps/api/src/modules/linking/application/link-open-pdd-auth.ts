// B1-06v: the Pinduoduo filing (备案) check of an open — a composition over the wired jd / pdd open
// (link-open-wiring.ts) adding the conversion port's authorize / cacheTag / prepare hooks, as the
// Taobao composition does (link-open-taobao.ts, which delegates its Pinduoduo opens here). The
// shared re-check core and the jd / pdd conversion itself know no authorization.
// Order of one Pinduoduo open: ownership (owner stage) → convert.enabled.pdd and path admission
// (50301) → this check → re-check price → conversion (orchestrator ruling D7-4 ②⑤).
// The check is judged on the identity snapshot's user, at (user, platform) granularity
// (TODO(规划/11 §4.5): BR-ID-22 的 (user, pid) 粒度 — blocked on union_bindings 加 pid 维度的迁移):
// - another user's share link (BR-ATTR-05 细则「别人的分享 link 不可用」, ruling D7-11 ①): the
//   sharer's stored binding only, never queried; not active (blocked included) → 30111
//   data.reason=sharer_auth_invalid, no auth_jump and no state; no_rebate is ignored there. Active
//   → 50301 reason=maintenance while the site authorization of the account it uses is expired.
// - own open: blocked → 30153 (a banned user: 10001) before anything else, except an explicit
//   no_rebate purchase, which goes out logged with no_rebate_reason=binding_blocked (BR-ID-18, the
//   server's value, never the client's). Then the site authorization of the account this
//   authorization uses (union-auth-reads.ts authAccountId) expired → 50301 reason=maintenance
//   (BR-ID-24 ④: conversion and the authority query depend on it), no_rebate included. no_rebate
//   and active go on; any other status (unbound, pending_auth, invalid, released, no row) asks the
//   union authority port (UnionAdapter.queryPddAuthority, an idempotent governed read) with the
//   same server-built identity the conversion uses (custom_parameters {app, uid=attr_code, sc},
//   never a user_id; no attr_code or no active slot → 50301): authorized → the binding is written
//   active (below) and the open goes on; not authorized → 30111 with data.auth_jump only, a
//   one-time state bound to uid + device record + the link this open serves (BR-ID-22 细则, the
//   auth-url jump construction); the port missing or failing → 50303, nothing written.
// Binding writes (single writer linking; approvals #26): every status written is first judged by
// canTransitionBinding, then a row_version compare-and-set; the unreleased row (pending_auth /
// invalid) is set active in place, else a stored `unbound` row (a projection value, judged as no
// binding), else a new active row of the account used — released history is never touched. The
// write runs under a savepoint inside the open's transaction (ruling D7-11 ④; no second pooled
// connection): a concurrent writer winning the unique index re-reads and decides on what won.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { newUuidV7 } from '../../platform/index.ts';
import type { UnionPidRow } from '../../union/index.ts';
import { canTransitionBinding } from '../domain/binding-status-transitions.ts';
import type { LinkOpenService } from './link-open.ts';
import { LinkingUnionIdentity } from './link-open-conversion.ts';
import type { LinkOpenOwnerResult } from './link-open-owner.ts';
import { openScopedAttrCodes, openScopedPids, type LinkOpenReadPlan } from './link-open-reads.ts';
import type { LinkOpenAuthorization, LinkOpenAuthorizationInput } from './link-open-requote.ts';
import { attrCodeOf } from './link-registration.ts';
import { createWiredLinkOpen, type WiredLinkOpenOptions } from './link-open-wiring.ts';
import {
  AuthConfigError,
  UNRELEASED,
  createUnionAuthReads,
  type AuthClient,
} from './union-auth-reads.ts';
import {
  AUTH_STATE_TTL_MS,
  deviceClientOf,
  insertAuthSession,
  newAuthState,
  syntheticAuthUrl,
} from './union-auth-state.ts';
import { pddAuthJump, type UnionAuthUrlOptions } from './union-auth-url.ts';

export type PddAuthLinkOpenOptions = WiredLinkOpenOptions & Pick<UnionAuthUrlOptions, 'appEnv'>;

type PidScene = Parameters<WiredLinkOpenOptions['pids']['getActivePid']>[0]['pidScene'];

const PLATFORM = 'pdd';
const ATTR_CODE = /^[0-9a-z]{8}$/;
const ACTIVATE_ATTEMPTS = 3;

const SHARER_INVALID: LinkOpenAuthorization = {
  kind: 'refused',
  code: 30111,
  data: { reason: 'sharer_auth_invalid' },
};
const MAINTENANCE: LinkOpenAuthorization = {
  kind: 'refused',
  code: 50301,
  data: { reason: 'maintenance' },
};
const QUERY_FAILED: LinkOpenAuthorization = { kind: 'refused', code: 50303 };

function paused(message: string): Error & { readonly code: 50301 } {
  return Object.assign(new Error(message), { code: 50301 as const });
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === '23505'
  );
}

interface BindingRow {
  readonly id: string;
  readonly status: string;
  readonly union_account_id: string;
  readonly row_version: number;
}

type Activation =
  | { readonly kind: 'active'; readonly id: string; readonly accountId: string }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'retry' };

/**
 * The cache tag of a Pinduoduo open (link-open-requote.ts cacheTag): a cached jump is reused only
 * when built for the same active binding and account and the same selected slot (BR-ID-17: a
 * rebind within the TTL is a miss); no_rebate by its slot alone. Not authorized: a tag no stored
 * entry has.
 */
export function pddCacheTag(
  decided:
    | {
        readonly binding: { readonly id: string; readonly accountId: string } | null;
        readonly slot: Pick<UnionPidRow, 'pid' | 'union_account_id'> | null;
      }
    | undefined,
  noRebate: boolean,
): string {
  if (decided === undefined) return 'unauthorized';
  const slot = [decided.slot?.union_account_id ?? null, decided.slot?.pid ?? null];
  if (noRebate) return JSON.stringify(['no_rebate', ...slot]);
  if (decided.binding === null) return 'unauthorized';
  return JSON.stringify(['binding', decided.binding.id, decided.binding.accountId, ...slot]);
}

/** The Pinduoduo filing check as conversion-port hooks; other platforms pass through. */
export function createPddAuthorization(options: PddAuthLinkOpenOptions) {
  const { clock, logger, registry, appEnv, environment } = options;
  // Inside the open's transaction these answer only from the pre-reads (link-open-reads.ts).
  const pids = openScopedPids(options.pids);
  const attrCodes = openScopedAttrCodes(options.attrCodes);
  const decisions = new WeakMap<LinkOpenOwnerResult, Parameters<typeof pddCacheTag>[0]>();

  /** authAccountId's self_buy slot; the scenes' slots and attr_codes are the wired prepare's. */
  async function prepare(plan: LinkOpenReadPlan): Promise<void> {
    if (plan.platform !== PLATFORM) return;
    await Promise.allSettled([
      pids.getActivePid({
        appId: plan.appId,
        platform: PLATFORM,
        pidScene: 'self_buy',
        purpose: 'convert',
      }),
    ]);
  }

  async function bindingRows(executor: Kysely<DB>, appId: string, userId: string) {
    return executor
      .selectFrom('union_bindings')
      .select(['id', 'status', 'union_account_id', 'row_version'])
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .where('platform', '=', PLATFORM)
      .execute();
  }

  /** The slot the conversion will use (validated again there); null when there is none. */
  async function slotOf(appId: string, pidScene: string) {
    try {
      const row = await pids.getActivePid({
        appId,
        platform: PLATFORM,
        pidScene: pidScene as PidScene,
        purpose: 'convert',
      });
      return row === null ? null : { pid: row.pid, union_account_id: row.union_account_id };
    } catch {
      return null;
    }
  }

  async function allow(
    owner: LinkOpenOwnerResult,
    noRebate: boolean,
    binding: { readonly id: string; readonly accountId: string } | null,
    blocked = false,
  ): Promise<LinkOpenAuthorization> {
    const { link, identitySnapshot } = owner;
    const slot = await slotOf(link.app_id, noRebate ? 'self_buy' : identitySnapshot.pid_scene);
    decisions.set(owner, { binding, slot });
    return blocked ? { kind: 'allowed', noRebateReason: 'binding_blocked' } : { kind: 'allowed' };
  }

  /** The identity the conversion builds for this snapshot (link-open-conversion.ts identityFor). */
  async function identityOf(owner: LinkOpenOwnerResult, traceId: string) {
    const { link, identitySnapshot } = owner;
    const appId = link.app_id;
    const pidScene = identitySnapshot.pid_scene;
    const row = await pids.getActivePid({
      appId,
      platform: PLATFORM,
      pidScene: pidScene as PidScene,
      purpose: 'convert',
    });
    if (
      row === null ||
      row.status !== 'active' ||
      row.app_id !== appId ||
      row.platform !== PLATFORM ||
      row.pid_scene !== pidScene ||
      row.pid === ''
    ) {
      logger.warn(
        {
          event: 'linking.open.no_active_pid',
          app_id: appId,
          platform: PLATFORM,
          pid_scene: pidScene,
        },
        'linking: no active promotion slot for the pdd authority query',
      );
      throw paused('linking: no active promotion slot');
    }
    const attrCode = await attrCodeOf(attrCodes, appId, identitySnapshot.user_id);
    if (attrCode === null || !ATTR_CODE.test(attrCode)) {
      logger.warn(
        {
          event: 'linking.open.attr_code_unavailable',
          app_id: appId,
          platform: PLATFORM,
          trace_id: traceId,
        },
        'linking: attr_code unavailable for the pdd authority query',
      );
      throw paused('linking: attr_code unavailable');
    }
    return new LinkingUnionIdentity({
      appId,
      platform: PLATFORM,
      promotionSlot: row.pid,
      userKey: attrCode,
      customParameters: { app: 'n', uid: attrCode, sc: pidScene },
    });
  }

  /** One decision on the rows as read now; writes are conditional (canTransition + CAS). */
  async function activateOnce(
    executor: Kysely<DB>,
    appId: string,
    userId: string,
    accountId: string,
    custom: string,
  ): Promise<Activation> {
    const now = clock.now();
    const rows: BindingRow[] = await bindingRows(executor, appId, userId);
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
      return updated.numUpdatedRows === 1n
        ? { kind: 'active', id: stored.id, accountId: account }
        : { kind: 'retry' };
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
        platform: PLATFORM,
        union_account_id: accountId,
        relation_id: null,
        pdd_custom: custom,
        status: 'active',
        bound_at: now,
        released_at: null,
        cooldown_until: null,
        blocked_reason: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return { kind: 'active', id, accountId };
  }

  async function activate(
    executor: Kysely<DB>,
    appId: string,
    userId: string,
    accountId: string,
    custom: string,
  ): Promise<Activation> {
    for (let attempt = 1; ; attempt += 1) {
      let decision: Activation;
      // A failed statement aborts the transaction: each attempt runs under its own savepoint, so a
      // lost unique race undoes only that attempt and the next one reads what won.
      await sql`SAVEPOINT pdd_binding_activate`.execute(executor);
      try {
        decision = await activateOnce(executor, appId, userId, accountId, custom);
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

  /** 30111 with an auth_jump whose state is bound to uid + device record + the served link. */
  async function issue(
    input: LinkOpenAuthorizationInput,
    userId: string,
  ): Promise<LinkOpenAuthorization> {
    const { caller, owner, executor } = input;
    const appId = owner.link.app_id;
    if (caller.deviceId === null || caller.userId !== userId) {
      return { kind: 'refused', code: 10001 };
    }
    let client: AuthClient | 'missing';
    try {
      client = await deviceClientOf(executor, appId, caller.deviceId);
    } catch (error) {
      // A device with no app client (h5 / web) has no authorization path in the open.
      if (error instanceof AuthConfigError) throw paused('linking: no pdd authorization path');
      throw error;
    }
    if (client === 'missing') return { kind: 'refused', code: 10001 };
    const now = clock.now();
    // A second reading of the injected clock, moved by the TTL (no `new Date` outside the clock).
    const expireAt = clock.now();
    expireAt.setTime(now.getTime() + AUTH_STATE_TTL_MS);
    const state = newAuthState();
    let authJump;
    try {
      authJump = pddAuthJump(
        { appEnv, jumpEnvironment: environment },
        syntheticAuthUrl(PLATFORM, state),
        client,
        input.installed,
        expireAt,
      );
    } catch (error) {
      if (error instanceof AuthConfigError) throw paused('linking: no admitted pdd auth jump');
      throw error;
    }
    await insertAuthSession(executor, {
      state,
      appId,
      userId,
      deviceId: caller.deviceId,
      platform: PLATFORM,
      client,
      linkId: owner.link.link_id,
      now,
      expireAt,
      methods: null,
      refs: null,
    });
    return { kind: 'refused', code: 30111, data: { auth_jump: authJump } };
  }

  /** The union authority port; missing or failing → null (50303, nothing written). */
  async function queried(
    owner: LinkOpenOwnerResult,
    identity: LinkingUnionIdentity,
    traceId: string,
  ): Promise<boolean | null> {
    const appId = owner.link.app_id;
    try {
      const adapter = registry.get(PLATFORM);
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
      logger.warn(
        {
          event: 'linking.open.pdd_authority_query_failed',
          app_id: appId,
          platform: PLATFORM,
          trace_id: traceId,
          error_code: String((error as { code?: unknown } | null)?.code ?? 'unknown'),
        },
        'linking: pdd authority query failed; binding left unchanged',
      );
      return null;
    }
  }

  async function authorize(input: LinkOpenAuthorizationInput): Promise<LinkOpenAuthorization> {
    const { caller, owner, noRebate, executor } = input;
    if (owner.link.platform !== PLATFORM) return { kind: 'allowed' };
    const { link, identitySnapshot: snapshot } = owner;
    const appId = link.app_id;
    const subject = snapshot.user_id;
    const reads = createUnionAuthReads({ db: executor, config: options.config, appEnv, pids });
    const sharedByOther = snapshot.pid_scene === 'share' && subject !== caller.userId;
    if (subject === null) {
      // Only a guest's unclaimed share link can name no user: its sharer has no binding.
      if (sharedByOther) return SHARER_INVALID;
      throw new Error('linking: an own pdd open without a snapshot user');
    }
    const rows = await bindingRows(executor, appId, subject);
    const unreleased = rows.find((row) => UNRELEASED.includes(row.status));
    const status = unreleased?.status ?? 'unbound';
    const bound = unreleased === undefined ? null : unreleased.union_account_id;
    const active =
      unreleased?.status === 'active' ? { id: unreleased.id, accountId: bound! } : null;

    // BR-ATTR-05 细则: judged on the sharer's stored binding; its status is never disclosed.
    if (sharedByOther && status !== 'active') return SHARER_INVALID;
    if (status === 'blocked' && !noRebate) {
      // A banned user has no session (BR-ID-31); one still reaching here asks to log in.
      if (await reads.userBanned(appId, subject)) return { kind: 'refused', code: 10001 };
      return { kind: 'refused', code: 30153 };
    }
    // BR-ID-24 ④: the account this authorization uses, never "any account still valid".
    const accountId = await reads.authAccountId(appId, PLATFORM, bound);
    if (accountId === null || !(await reads.siteAuthAvailable(appId, PLATFORM, accountId))) {
      return MAINTENANCE;
    }
    if (noRebate) return allow(owner, true, null, status === 'blocked');
    if (active !== null) return allow(owner, false, active);

    const identity = await identityOf(owner, input.traceId);
    const authorized = await queried(owner, identity, input.traceId);
    if (authorized === null) return QUERY_FAILED;
    if (!authorized) return issue(input, subject);
    const custom = JSON.stringify(identity.custom_parameters);
    const written = await activate(executor, appId, subject, accountId, custom);
    if (written.kind === 'blocked') return { kind: 'refused', code: 30153 };
    if (written.kind !== 'active') throw new Error('linking: pdd binding not activated');
    return allow(owner, false, { id: written.id, accountId: written.accountId });
  }

  function cacheTag(owner: LinkOpenOwnerResult, noRebate: boolean): string | undefined {
    if (owner.link.platform !== PLATFORM) return undefined;
    return pddCacheTag(decisions.get(owner), noRebate);
  }

  return { prepare, authorize, cacheTag };
}

export function createPddAuthLinkOpen(options: PddAuthLinkOpenOptions): LinkOpenService {
  return createWiredLinkOpen(options, (wired) => {
    const pdd = createPddAuthorization(options);
    return {
      ...wired.conversion,
      async prepare(plan) {
        await Promise.allSettled([wired.conversion.prepare(plan), pdd.prepare(plan)]);
      },
      authorize: pdd.authorize,
      cacheTag: pdd.cacheTag,
    };
  });
}
