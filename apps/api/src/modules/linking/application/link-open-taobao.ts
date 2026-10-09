// B1-06f: the Taobao open — a composition over the shared open core (owner, re-check, idempotency,
// logs, attempts; link-open-requote.ts) and the jd / pdd wired conversion (link-open-wiring.ts),
// adding a Taobao conversion port with its own authorization. The re-check core itself knows no
// authorization; jd and pdd opens are served exactly as before.
// Order of one Taobao open: ownership (10001 / 30144, owner stage) → convert.enabled.taobao and
// path admission (50301) → the scene's active promotion slot (50301 with a warning) →
// authorization (30153 / 30101 / 30102) → re-check price (30141 / 30602 / 50303) → instruction.
// Authorization (BR-ATTR-05, BR-ID-17, BR-ID-18, BR-ID-24 ④) is judged on the identity snapshot's
// user (the sharer on another user's share link):
// - another user's share link whose sharer has no active binding (any status, blocked included,
//   whatever the site authorization) → 30102 reason=sharer_auth_invalid, no state; no_rebate is
//   ignored there (BR-ATTR-05 ①).
// - blocked → 30153; an explicit no_rebate open goes out instead, logged with no_rebate_reason
//   binding_blocked (decided here, never the client's value).
// - unbound / pending_auth / released → 30101, invalid → 30102: while the site authorization of
//   the account this authorization uses (union-auth-reads.ts) is expired, reason=auth_unavailable
//   with no state, no_rebate included; otherwise an explicit no_rebate open goes out, else a
//   one-time state bound to uid + device + the link this open serves (union-auth-state.ts).
// - active → the instruction with the snapshot user's relation_id (only that user's active
//   binding in this app).
// The instruction (BR-ATTR-27 Taobao row; 02 §5.1): no union link API is called (the Taobao
// adapter's convert / resolveLink are never used). Our own promotion link of this link's user and
// scene (links.promo_url) usable before links.expire_at → openByUrl with no commission parameter,
// followed on app clients by the same URL as an h5 step; otherwise openByCode on the detail page
// with taoke {pid of the scene's active slot, relation_id of the snapshot user} — no_rebate uses
// the self_buy slot with no user parameter and never the promotion link. h5 / web get only the
// promotion link (h5), else 50301. Whether the SDK returns to the app is CAP-TB-11, not promised;
// prod hands out no Taobao path until it is verified (link-open-wiring.ts admission).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { UnionPidRow } from '../../union/index.ts';
import {
  CONVERT_CACHE_TTL_SEC,
  MAX_CONVERT_CACHE_TTL_SEC,
  intSetting,
  isSwitchOn,
} from '../domain/rules.ts';
import type { LinkOpenService } from './link-open.ts';
import type { LinkOpenOwnerResult } from './link-open-owner.ts';
import { openScopedConfig, openScopedPids, type LinkOpenReadPlan } from './link-open-reads.ts';
import type {
  LinkOpenAuthorization,
  LinkOpenAuthorizationInput,
  LinkOpenConversionInput,
  LinkOpenJump,
} from './link-open-requote.ts';
import {
  createWiredLinkOpen,
  type WiredConversion,
  type WiredLinkOpenOptions,
} from './link-open-wiring.ts';
import { AuthConfigError, createUnionAuthReads, type AuthClient } from './union-auth-reads.ts';
import {
  AUTH_STATE_TTL_MS,
  authAppRefs,
  deviceClientOf,
  insertAuthSession,
  newAuthState,
  syntheticAuthUrl,
} from './union-auth-state.ts';
import type { UnionAuthUrlOptions } from './union-auth-url.ts';

/** B1-06f: composition boundary; authorization must not enter the shared requote core. */
export type TaobaoLinkOpenOptions = WiredLinkOpenOptions &
  Pick<UnionAuthUrlOptions, 'appEnv' | 'authApps'>;

type PidScene = Parameters<WiredLinkOpenOptions['pids']['getActivePid']>[0]['pidScene'];
type Step = LinkOpenJump['primary'];

const PLATFORM = 'taobao';
const SWITCH = 'convert.enabled.taobao';
const AUTH_CLIENTS: readonly AuthClient[] = ['ios', 'android', 'harmony'];
/** contracts BaichuanTaoke.pid. */
const PID = /^mm_\d+_\d+_\d+$/;
const PID_MAX = 64;
/** contracts BaichuanTaoke.relation_id and BaichuanOpen.item_id / url bounds. */
const RELATION_MAX = 32;
const ITEM_MAX = 64;
const URL_MAX = 2048;

function paused(message: string): Error & { readonly code: 50301 } {
  return Object.assign(new Error(message), { code: 50301 as const });
}

/** The relation this open's authorization settled on, per owner stage result. */
interface Authorized {
  readonly relationId: string | null;
}

/**
 * Our own promotion link of the opened link (decision D7-4 #6): both columns set, an https URI of
 * at most 2048 characters, and the injected clock still before links.expire_at (W_link).
 */
function promoOf(link: LinkOpenOwnerResult['link'], nowMs: number): string | null {
  const url = link.promo_url;
  if (url === null || link.promo_url_fetched_at === null) return null;
  if (typeof url !== 'string' || url.length === 0 || url.length > URL_MAX) return null;
  if (!(nowMs < link.expire_at.getTime())) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === 'https:' && parsed.host !== '' ? url : null;
}

/** The Taobao conversion port: admission, authorization and the Baichuan instruction. */
function createTaobaoConversion(
  options: TaobaoLinkOpenOptions,
  admission: WiredConversion['admission'],
) {
  const { clock, logger, authApps, appEnv } = options;
  // Inside the open's transaction these answer only from the pre-reads (link-open-reads.ts).
  const config = openScopedConfig(options.config);
  const pids = openScopedPids(options.pids);
  const authorized = new WeakMap<LinkOpenOwnerResult, Authorized>();

  async function prepare(plan: LinkOpenReadPlan): Promise<void> {
    const { appId } = plan;
    const scenes = new Set<string>(['self_buy']);
    for (const identity of plan.identities) {
      scenes.add(identity.noRebate ? 'self_buy' : identity.pidScene);
    }
    await Promise.allSettled([
      config.configValue(appId, SWITCH),
      config.configValue(appId, CONVERT_CACHE_TTL_SEC),
      ...AUTH_CLIENTS.map((client) =>
        config.configValue(appId, `union.taobao.auth_methods.${client}`),
      ),
      ...[...scenes].map((pidScene) =>
        pids.getActivePid({
          appId,
          platform: PLATFORM,
          pidScene: pidScene as PidScene,
          purpose: 'convert',
        }),
      ),
    ]);
  }

  async function admit(owner: LinkOpenOwnerResult, client: LinkOpenConversionInput['client']) {
    const value = await config.configValue(owner.link.app_id, SWITCH);
    if (!isSwitchOn(value?.value)) {
      throw paused('linking: taobao conversion switched off');
    }
    if (!admission.possible(PLATFORM, client)) {
      // TODO(规划/11 §4.5): 淘宝打开路径的生产放行 — blocked on CAP-TB-11 实测。
      throw paused('linking: no verified taobao jump path for this client');
    }
  }

  /** The scene's active promotion slot; none (or not a Taobao pid) → 50301 with a warning. */
  async function activePid(appId: string, pidScene: string): Promise<UnionPidRow> {
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
      typeof row.pid !== 'string' ||
      row.pid.length > PID_MAX ||
      !PID.test(row.pid)
    ) {
      logger.warn(
        {
          event: 'linking.open.no_active_pid',
          app_id: appId,
          platform: PLATFORM,
          pid_scene: pidScene,
        },
        'linking: no active taobao promotion slot for the open',
      );
      throw paused('linking: no active promotion slot');
    }
    return row;
  }

  /** The snapshot user's own active binding in this app; its relation_id within the contract. */
  async function activeRelation(executor: Kysely<DB>, appId: string, userId: string) {
    const row = await executor
      .selectFrom('union_bindings')
      .select('relation_id')
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .where('platform', '=', PLATFORM)
      .where('status', '=', 'active')
      .executeTakeFirst();
    const relation = row?.relation_id ?? null;
    if (relation === null || relation === '' || relation.length > RELATION_MAX) {
      logger.warn(
        { event: 'linking.open.relation_unavailable', app_id: appId, platform: PLATFORM },
        'linking: active taobao binding without a usable relation_id',
      );
      throw paused('linking: active binding without a usable relation_id');
    }
    return relation;
  }

  async function authorize(input: LinkOpenAuthorizationInput): Promise<LinkOpenAuthorization> {
    const { caller, owner, noRebate, executor } = input;
    const { link, identitySnapshot: snapshot } = owner;
    const appId = link.app_id;
    await activePid(appId, noRebate ? 'self_buy' : snapshot.pid_scene);
    const sharedByOther = snapshot.pid_scene === 'share' && snapshot.user_id !== caller.userId;
    const subject = snapshot.user_id;
    if (subject === null) {
      // Only a guest's unclaimed share link can name no user: its sharer has no binding.
      if (sharedByOther)
        return { kind: 'refused', code: 30102, data: { reason: 'sharer_auth_invalid' } };
      throw new Error('linking: an own taobao open without a snapshot user');
    }
    const reads = createUnionAuthReads({ db: executor, config, appEnv, pids });
    const { status, accountId: bound } = await reads.binding(appId, subject, PLATFORM);

    if (status === 'active') {
      // no_rebate carries no user parameter, so it needs no relation_id.
      const relationId = noRebate ? null : await activeRelation(executor, appId, subject);
      authorized.set(owner, { relationId });
      return { kind: 'allowed' };
    }
    // BR-ATTR-05 细则「别人的分享 link 不可用」: the sharer's status is never disclosed.
    if (sharedByOther) {
      return { kind: 'refused', code: 30102, data: { reason: 'sharer_auth_invalid' } };
    }
    if (status === 'blocked') {
      // BR-ID-18: an explicit no_rebate purchase goes out; the reason is the server's.
      if (noRebate) {
        authorized.set(owner, { relationId: null });
        return { kind: 'allowed', noRebateReason: 'binding_blocked' };
      }
      // A banned user has no session (BR-ID-31); one still reaching here asks to log in.
      if (await reads.userBanned(appId, subject)) return { kind: 'refused', code: 10001 };
      return { kind: 'refused', code: 30153 };
    }
    const code = status === 'invalid' ? 30102 : 30101;
    const accountId = await reads.authAccountId(appId, PLATFORM, bound);
    // BR-ID-24 ④: the exception holds for no_rebate too.
    if (!(await reads.siteAuthAvailable(appId, PLATFORM, accountId))) {
      return { kind: 'refused', code, data: { reason: 'auth_unavailable' } };
    }
    if (noRebate) {
      authorized.set(owner, { relationId: null });
      return { kind: 'allowed' };
    }
    return issue(executor, caller, owner, subject, code);
  }

  /** 30101 / 30102 with a one-time state bound to uid + device + the link this open serves. */
  async function issue(
    executor: Kysely<DB>,
    caller: LinkOpenAuthorizationInput['caller'],
    owner: LinkOpenOwnerResult,
    userId: string,
    code: 30101 | 30102,
  ): Promise<LinkOpenAuthorization> {
    const appId = owner.link.app_id;
    if (caller.deviceId === null || caller.userId !== userId) {
      return { kind: 'refused', code: 10001 };
    }
    let client: AuthClient | 'missing';
    try {
      client = await deviceClientOf(executor, appId, caller.deviceId);
    } catch (error) {
      // A device with no app client (h5 / web) has no authorization path in the open.
      if (error instanceof AuthConfigError) throw paused('linking: no taobao authorization path');
      throw error;
    }
    if (client === 'missing') return { kind: 'refused', code: 10001 };
    const reads = createUnionAuthReads({ db: executor, config, appEnv, pids });
    const methods = await reads.configuredMethods(appId, client);
    const refs = await authAppRefs(authApps, appEnv, appId, client, methods);
    const now = clock.now();
    // A second reading of the injected clock, moved by the TTL (no `new Date` outside the clock).
    const expireAt = clock.now();
    expireAt.setTime(now.getTime() + AUTH_STATE_TTL_MS);
    const state = newAuthState();
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
      methods,
      refs,
    });
    return {
      kind: 'refused',
      code,
      data: { auth_url: syntheticAuthUrl(PLATFORM, state), state, auth_methods: [...methods] },
    };
  }

  /** now + link.convert_cache_ttl_sec (default and ceiling 900 s), as the jd / pdd plans. */
  async function jumpExpiry(appId: string): Promise<Date> {
    const configured = intSetting(
      (await config.configValue(appId, CONVERT_CACHE_TTL_SEC))?.value,
      MAX_CONVERT_CACHE_TTL_SEC,
    );
    const sec =
      configured > 0 && configured <= MAX_CONVERT_CACHE_TTL_SEC
        ? configured
        : MAX_CONVERT_CACHE_TTL_SEC;
    const at = clock.now();
    at.setTime(at.getTime() + sec * 1000);
    return at;
  }

  async function convert(input: LinkOpenConversionInput): Promise<LinkOpenJump> {
    const { owner, noRebate, client } = input;
    const { link, identitySnapshot: snapshot } = owner;
    const appId = link.app_id;
    const pid = await activePid(appId, noRebate ? 'self_buy' : snapshot.pid_scene);
    const decided = authorized.get(owner);
    if (decided === undefined) throw paused('linking: taobao open converted without authorization');
    const nowMs = clock.now().getTime();
    const expireAt = await jumpExpiry(appId);
    // Our promotion link only for this link's own user and scene, never for no_rebate.
    const promo =
      !noRebate && link.user_id === snapshot.user_id && link.pid_scene === snapshot.pid_scene
        ? promoOf(link, nowMs)
        : null;
    let steps: Step[];
    if (promo !== null) {
      // The plan never outlives the promotion link's W_link.
      if (link.expire_at.getTime() < expireAt.getTime()) expireAt.setTime(link.expire_at.getTime());
      const h5: Step = { type: 'h5', value: promo };
      steps =
        client === 'h5' || client === 'web'
          ? [h5]
          : [
              {
                type: 'sdk',
                value: promo,
                sdk: { provider: 'baichuan', open_by: 'url', url: promo },
              },
              h5,
            ];
    } else {
      if (client === 'h5' || client === 'web') {
        throw paused('linking: no taobao path for this client without our promotion link');
      }
      const itemId = link.raw_item_id;
      if (itemId === null || itemId === '' || itemId.length > ITEM_MAX) {
        throw new Error('linking: link has no taobao item id for the instruction');
      }
      const relationId = noRebate ? null : decided.relationId;
      if (!noRebate && relationId === null) {
        throw paused('linking: no relation_id for an attributed taobao open');
      }
      steps = [
        {
          type: 'sdk',
          value: itemId,
          sdk: {
            provider: 'baichuan',
            open_by: 'code',
            page: 'detail',
            item_id: itemId,
            taoke: { pid: pid.pid, ...(relationId === null ? {} : { relation_id: relationId }) },
          },
        },
      ];
    }
    const [primary, ...fallbacks] = steps as [Step, ...Step[]];
    const jump: LinkOpenJump = { primary, fallbacks, expire_at: expireAt.toISOString() };
    const admitted = admission.jump(PLATFORM, client, jump);
    if (admitted === null) throw paused('linking: no verified taobao jump path for this client');
    return admitted;
  }

  /**
   * BR-ID-17: a cached instruction is reused only when it was built for the relation_id of the
   * snapshot user's current active binding (a rebind within the TTL gets a new relation_id: the
   * old instruction is a miss and is rebuilt). no_rebate carries no user parameter and has no tag;
   * its key differs from the attributed one (noRebate), so the two never hit each other.
   */
  function cacheTag(owner: LinkOpenOwnerResult, noRebate: boolean): string | undefined {
    if (noRebate) return undefined;
    const decided = authorized.get(owner);
    // Not authorized here: a tag no stored entry has, so nothing cached is reused.
    if (decided === undefined || decided.relationId === null) return 'unauthorized';
    return `relation:${decided.relationId}`;
  }

  return { prepare, admit, authorize, cacheTag, convert };
}

export function createTaobaoLinkOpen(options: TaobaoLinkOpenOptions): LinkOpenService {
  return createWiredLinkOpen(options, (wired) => {
    const taobao = createTaobaoConversion(options, wired.admission);
    const isTaobao = (owner: LinkOpenOwnerResult) => owner.link.platform === PLATFORM;
    return {
      variant: wired.conversion.variant,
      async prepare(plan) {
        await Promise.allSettled([
          wired.conversion.prepare(plan),
          ...(plan.platform === PLATFORM ? [taobao.prepare(plan)] : []),
        ]);
      },
      admit: (owner, client) =>
        isTaobao(owner) ? taobao.admit(owner, client) : wired.conversion.admit(owner, client),
      authorize: (input) =>
        isTaobao(input.owner) ? taobao.authorize(input) : Promise.resolve({ kind: 'allowed' }),
      cacheTag: (owner, noRebate) =>
        isTaobao(owner) ? taobao.cacheTag(owner, noRebate) : undefined,
      convert: (input) =>
        isTaobao(input.owner) ? taobao.convert(input) : wired.conversion.convert(input),
    };
  });
}
