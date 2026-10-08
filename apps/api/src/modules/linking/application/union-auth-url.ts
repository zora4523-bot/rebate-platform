// B1-06g: GET /v1/unions/{platform}/auth-url — issues a one-time authorization state
// (union_auth_sessions, BR-ID-17: bound to uid + device_id, link_id empty, 10 minutes, single use,
// consumed by bindings in B1-06h) with the client of the DEVICE RECORD and, for Taobao, the
// ordered auth_methods of union.taobao.auth_methods.<client> plus each method's server-side
// application reference (BR-ID-17 细则「授权方式」). Pinduoduo gets an auth_jump plan instead
// (BR-ID-22 细则). Refusals: a blocked binding of a user who is not banned → 30153 (checked first,
// BR-ID-24 ④); the site's own union authorization expired → for Taobao 30101 / 30102 with
// data.reason=auth_unavailable, for Pinduoduo 50301 with data.reason=maintenance (BR-ID-24 ④,
// 2026-10-08: the Pinduoduo authorization link depends on that authorization, so it is not the
// Taobao special case). Both are judged for the requested platform only, after 30153.
//
// Cross-module reads (devices, user_risk_state, union_bindings, union_accounts) are read-only
// selects scoped by app_id, plus union's read-only active-pid port; this module writes only
// union_auth_sessions. The site authorization judged is that of the union account this
// authorization actually uses (the unreleased binding's, else the platform's active self_buy pid's,
// else the platform's first account in the pid service's order), never "any account still valid".
import { randomBytes } from 'node:crypto';
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { AppEnv, Clock, HandlerResult, RootLogger } from '../../platform/index.ts';
import type { UnionPidService } from '../../union/index.ts';
import type { CallerContext, LinkingConfigReader } from '../ports.ts';
import { appSchemeOf, buildDefaultLinkJump, pathsOf } from './link-open-conversion.ts';
import { createJumpAdmission, type LinkOpenEnvironment } from './link-open-wiring.ts';
import { createLinkingPidReader } from '../infra/pid-reader.ts';

export type AuthClient = 'ios' | 'android' | 'harmony';
export type UnionAuthMethod = components['schemas']['AuthMethod'];

export interface UnionAuthUrlInput {
  readonly platform: 'taobao' | 'pdd';
  readonly reportedClient: AuthClient;
  readonly installed?: components['schemas']['InstalledState'];
  readonly traceId: string;
}

export interface UnionAuthUrlOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly callerContext: CallerContext;
  readonly config: LinkingConfigReader;
  readonly appEnv: AppEnv;
  /** Server-owned application configuration references, scoped to the issuing environment. */
  readonly authApps: {
    resolve(
      appId: string,
      environment: AppEnv,
      client: AuthClient,
      method: UnionAuthMethod,
    ): Promise<{ readonly ref: string }>;
  };
  /**
   * union's read-only active-pid query (the account channel registration uses); absent → the same
   * read-only reader built on this db.
   */
  readonly pids?: Pick<UnionPidService, 'getActivePid'>;
  /**
   * The open's jump environment (apps.json, verified paths per platform × client): the Pinduoduo
   * auth_jump is built and admitted exactly as the open's (BR-ATTR-27). Absent (no
   * LINK_OPEN_PORTS) → the bridge's apps.json outside prod; prod fails closed.
   */
  readonly jumpEnvironment?: LinkOpenEnvironment;
  /** Risk log of a declared X-Platform that disagrees with the device record (optional). */
  readonly logger?: Pick<RootLogger, 'warn'>;
}

export interface UnionAuthUrlService {
  get(input: UnionAuthUrlInput): Promise<HandlerResult>;
}

type AuthJumpPlan = components['schemas']['AuthJumpPlan'];
type AuthJumpStep = components['schemas']['AuthJumpStep'];

/** BR-ID-17: a state lives 10 minutes. */
const STATE_TTL_MS = 600_000;
/** BR-ID-17 细则「授权方式」: the default when union.taobao.auth_methods.<client> is not set. */
const DEFAULT_METHODS: readonly UnionAuthMethod[] = Object.freeze(['web_code']);
const METHODS: ReadonlySet<string> = new Set<UnionAuthMethod>(['web_code', 'sdk_token']);
const CLIENTS: ReadonlySet<string> = new Set<AuthClient>(['ios', 'android', 'harmony']);
/** BR-ID-19: at most one unreleased binding per user and platform. */
const UNRELEASED = ['pending_auth', 'active', 'invalid', 'blocked'] as const;

const STATUS: Readonly<Record<number, number>> = {
  0: 200,
  10001: 401,
  30101: 422,
  30102: 422,
  30153: 422,
  50001: 500,
  50301: 503,
};

/** Fallback texts only; clients show the dictionary text error.<code> (BR-TEXT-14). */
const MESSAGES: Readonly<Record<number, string>> = {
  0: 'ok',
  10001: '请先登录',
  30101: '淘宝暂时无法下单，请稍后再试',
  30102: '淘宝暂时无法下单，请稍后再试',
  30153: '该平台返利已被停用，请联系客服',
  50001: '服务端错误',
  50301: '该平台暂时无法购买，请稍后再试',
};

function fail(code: number, traceId: string, data?: Record<string, unknown>): HandlerResult {
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

/** A configuration fault is a server fault: never guessed, never re-ordered or intersected. */
class AuthConfigError extends Error {}

/**
 * union.taobao.auth_methods.<client>: an ordered list of one or two distinct known methods, kept
 * exactly in its configured order. Absent → the default. Anything else is a configuration fault.
 */
function parseMethods(value: unknown): readonly UnionAuthMethod[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 2 ||
    !value.every((m) => typeof m === 'string' && METHODS.has(m)) ||
    new Set(value).size !== value.length
  ) {
    throw new AuthConfigError('linking: union.taobao.auth_methods is not an ordered method list');
  }
  return value as UnionAuthMethod[];
}

/**
 * 128+ random bits from the CSPRNG, base64url; it carries no identity in clear (BR-ID-17: the
 * binding to uid / device lives in the row, not in the state string).
 */
function newState(): string {
  return `st_${randomBytes(32).toString('base64url')}`;
}

/**
 * TODO(规划/11 §4.5): real authorization link generation — blocked on 推广位 / siteId 与联盟应用.
 * Until then a synthetic address on example.test carrying only the issued state.
 */
function syntheticAuthUrl(platform: 'taobao' | 'pdd', state: string): string {
  const host = platform === 'taobao' ? 'oauth.example.test' : 'auth.example.test';
  return `https://${host}/${platform}/authorize?state=${encodeURIComponent(state)}`;
}

const AUTH_STEP_TYPES: ReadonlySet<string> = new Set<AuthJumpStep['type']>([
  'scheme',
  'universal_link',
  'h5',
]);

function authStep(step: { readonly type: string; readonly value: string }): AuthJumpStep {
  if (!AUTH_STEP_TYPES.has(step.type)) {
    throw new AuthConfigError('linking: the auth jump has a step an auth plan cannot carry');
  }
  return { type: step.type as AuthJumpStep['type'], value: step.value };
}

export function createUnionAuthUrl(options: UnionAuthUrlOptions): UnionAuthUrlService {
  const { db, clock, callerContext, config, appEnv, authApps, jumpEnvironment, logger } = options;
  const pids = options.pids ?? createLinkingPidReader(db, clock);

  async function binding(
    appId: string,
    userId: string,
    platform: 'taobao' | 'pdd',
  ): Promise<{ readonly status: string; readonly accountId: string | null }> {
    const rows = await db
      .selectFrom('union_bindings')
      .select(['status', 'union_account_id'])
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .where('platform', '=', platform)
      .execute();
    // The projection of the authorization page (BR-ID-17 细则「授权管理页」): the unreleased
    // binding when there is one (its account is the one this authorization uses), else released
    // when a released row exists, else unbound.
    const unreleased = rows.find((row) => (UNRELEASED as readonly string[]).includes(row.status));
    if (unreleased !== undefined) {
      return { status: unreleased.status, accountId: unreleased.union_account_id };
    }
    return {
      status: rows.some((row) => row.status === 'released') ? 'released' : 'unbound',
      accountId: null,
    };
  }

  async function userBanned(appId: string, userId: string): Promise<boolean> {
    const row = await db
      .selectFrom('user_risk_state')
      .select('state')
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row?.state === 'banned';
  }

  /**
   * The union account this authorization uses: the unreleased binding's; otherwise the account of
   * the platform's active self_buy pid (union's own selection of the current pid, purpose convert);
   * otherwise the platform's first account in that same order. null: no account at all.
   */
  async function authAccountId(
    appId: string,
    platform: 'taobao' | 'pdd',
    bound: string | null,
  ): Promise<string | null> {
    if (bound !== null) return bound;
    const pid = await pids.getActivePid({
      appId,
      platform,
      pidScene: 'self_buy',
      purpose: 'convert',
    });
    if (pid !== null && pid.app_id === appId && pid.platform === platform) {
      return pid.union_account_id;
    }
    const first = await db
      .selectFrom('union_accounts')
      .select('id')
      .where('app_id', '=', appId)
      .where('platform', '=', platform)
      .orderBy('updated_at', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(1)
      .executeTakeFirst();
    return first?.id ?? null;
  }

  /**
   * BR-ID-24 ④: the site's authorization of exactly the account this authorization uses is
   * usable (not expired); another account of the platform being valid never masks it.
   */
  async function siteAuthAvailable(
    appId: string,
    platform: 'taobao' | 'pdd',
    accountId: string | null,
  ): Promise<boolean> {
    if (accountId === null) return false;
    const row = await db
      .selectFrom('union_accounts')
      .select('auth_status')
      .where('app_id', '=', appId)
      .where('platform', '=', platform)
      .where('id', '=', accountId)
      .executeTakeFirst();
    return row !== undefined && row.auth_status !== 'expired';
  }

  /**
   * Pinduoduo authorization jump (BR-ID-22 细则; 04 §7 30111): the open's own BR-ATTR-27 matrix by
   * the device record's client and installed (missing → unknown), over the authorization page's
   * paths; in prod only the paths the open admits (none admitted → a server fault, no state).
   */
  function pddJump(
    authUrl: string,
    client: AuthClient,
    installed: UnionAuthUrlInput['installed'],
    expireAt: Date,
  ): AuthJumpPlan {
    if (appEnv === 'prod' && jumpEnvironment === undefined) {
      throw new AuthConfigError('linking: no jump environment for the pdd auth jump in prod');
    }
    const jump = buildDefaultLinkJump({
      platform: 'pdd',
      client,
      installed: installed ?? 'unknown',
      paths: pathsOf('pdd', authUrl, appSchemeOf(jumpEnvironment?.apps, 'pdd')),
      expireAt: expireAt.toISOString(),
    });
    const admitted =
      jumpEnvironment === undefined
        ? jump
        : createJumpAdmission({ ...jumpEnvironment, appEnv }).jump('pdd', client, jump);
    if (admitted === null) {
      throw new AuthConfigError('linking: no verified pdd jump path for this client');
    }
    return {
      primary: authStep(admitted.primary),
      fallbacks: admitted.fallbacks.map(authStep),
      expire_at: admitted.expire_at,
    };
  }

  async function configuredMethods(appId: string, client: AuthClient) {
    const item = await config.configValue(appId, `union.taobao.auth_methods.${client}`);
    let methods = item === null ? DEFAULT_METHODS : parseMethods(item.value);
    // sdk_token waits for CAP-TB-05 (f) and the owner's confirmation: in prod it is filtered out,
    // never issued nor recorded (B1-04k 口径). Nothing left → the default.
    if (appEnv === 'prod') {
      methods = methods.filter((method) => method !== 'sdk_token');
      if (methods.length === 0) methods = DEFAULT_METHODS;
    }
    return methods;
  }

  async function appRefs(
    appId: string,
    client: AuthClient,
    methods: readonly UnionAuthMethod[],
  ): Promise<Record<string, string>> {
    const refs: Record<string, string> = {};
    for (const method of methods) {
      // Only the reference leaves the resolver; nothing else it returns is kept.
      const { ref } = await authApps.resolve(appId, appEnv, client, method);
      if (typeof ref !== 'string' || ref.trim() === '') {
        throw new AuthConfigError('linking: no application reference for an auth method');
      }
      refs[method] = ref;
    }
    return refs;
  }

  async function issue(input: UnionAuthUrlInput): Promise<HandlerResult> {
    const caller = await callerContext.current();
    if (caller.userId === null || caller.deviceId === null) return fail(10001, input.traceId);
    const { appId, userId, deviceId } = caller;

    // The client is the device record's (BR-ID-17 细则), never the X-Platform declaration.
    const device = await db
      .selectFrom('devices')
      .select(['platform', 'revoked_at'])
      .where('app_id', '=', appId)
      .where('id', '=', deviceId)
      .executeTakeFirst();
    if (device === undefined || device.revoked_at !== null) return fail(10001, input.traceId);
    if (!CLIENTS.has(device.platform)) {
      throw new AuthConfigError('linking: device record carries no supported client');
    }
    const client = device.platform as AuthClient;
    if (client !== input.reportedClient) {
      logger?.warn(
        {
          event: 'linking.auth_url.client_mismatch',
          app_id: appId,
          device_id: deviceId,
          platform: input.platform,
          recorded_client: client,
          reported_client: input.reportedClient,
        },
        'linking: X-Platform disagrees with the device record; the record is used',
      );
    }

    const platform = input.platform;
    const { status, accountId: bound } = await binding(appId, userId, platform);
    // A blocked binding answers 30153 before anything else (BR-ID-24 ④ keeps it for blocked).
    if (status === 'blocked') {
      // A banned user has no session (BR-ID-31); one still reaching here gets no state either.
      if (await userBanned(appId, userId)) return fail(10001, input.traceId);
      return fail(30153, input.traceId);
    }
    const accountId = await authAccountId(appId, platform, bound);
    if (!(await siteAuthAvailable(appId, platform, accountId))) {
      // BR-ID-24 ④ (2026-10-08): Pinduoduo's authorization link depends on the site's
      // authorization → 50301 maintenance; the 30101 / 30102 special case is Taobao's only.
      if (platform === 'pdd') return fail(50301, input.traceId, { reason: 'maintenance' });
      return fail(status === 'invalid' ? 30102 : 30101, input.traceId, {
        reason: 'auth_unavailable',
      });
    }

    const methods = platform === 'taobao' ? await configuredMethods(appId, client) : null;
    // Built before the insert: a pdd jump that cannot be issued leaves no state behind.
    const now = clock.now();
    // A second reading of the injected clock, moved by the TTL (no `new Date` outside the clock).
    const expireAt = clock.now();
    expireAt.setTime(now.getTime() + STATE_TTL_MS);
    const state = newState();
    const authUrl = syntheticAuthUrl(platform, state);
    const authJump = methods === null ? pddJump(authUrl, client, input.installed, expireAt) : null;
    const refs = methods === null ? null : await appRefs(appId, client, methods);

    await db
      .insertInto('union_auth_sessions')
      .values({
        state,
        app_id: appId,
        user_id: userId,
        device_id: deviceId,
        platform,
        mode: 'bind',
        link_id: null,
        expire_at: expireAt,
        used_at: null,
        created_at: now,
        client,
        auth_methods: methods === null ? null : [...methods],
        auth_app_refs:
          refs === null
            ? null
            : sql<DB['union_auth_sessions']['auth_app_refs']>`${JSON.stringify(refs)}::jsonb`,
      })
      .execute();

    const data =
      methods === null
        ? { auth_url: authUrl, state, auth_jump: authJump }
        : { auth_url: authUrl, state, auth_methods: [...methods] };
    return {
      status: 200,
      envelope: { code: 0, msg: MESSAGES[0]!, data, trace_id: input.traceId },
    };
  }

  return {
    async get(input) {
      try {
        return await issue(input);
      } catch (error) {
        if (error instanceof AuthConfigError) return fail(50001, input.traceId);
        throw error;
      }
    },
  };
}
