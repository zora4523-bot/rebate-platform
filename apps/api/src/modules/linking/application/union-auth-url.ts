// B1-06g: GET /v1/unions/{platform}/auth-url — issues a one-time authorization state
// (union_auth_sessions, BR-ID-17: bound to uid + device_id, link_id empty, 10 minutes, single use,
// consumed by bindings in B1-06h) with the client of the DEVICE RECORD and, for Taobao, the
// ordered auth_methods of union.taobao.auth_methods.<client> plus each method's server-side
// application reference (BR-ID-17 细则「授权方式」). Pinduoduo gets an auth_jump plan instead
// (BR-ID-22 细则). Refusals: a blocked binding of a user who is not banned → 30153 (checked first,
// BR-ID-24 ④); the site's own union authorization expired → 30101 / 30102 with
// data.reason=auth_unavailable (BR-ID-24 ④). Both are judged for the requested platform only.
//
// Cross-module reads (devices, user_risk_state, union_accounts) are read-only selects scoped by
// app_id; this module writes only union_auth_sessions.
import { randomBytes } from 'node:crypto';
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { AppEnv, Clock, HandlerResult, RootLogger } from '../../platform/index.ts';
import type { CallerContext, LinkingConfigReader } from '../ports.ts';

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
};

/** Fallback texts only; clients show the dictionary text error.<code> (BR-TEXT-14). */
const MESSAGES: Readonly<Record<number, string>> = {
  0: 'ok',
  10001: '请先登录',
  30101: '淘宝暂时无法下单，请稍后再试',
  30102: '淘宝暂时无法下单，请稍后再试',
  30153: '该平台返利已被停用，请联系客服',
  50001: '服务端错误',
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

/**
 * Pinduoduo authorization jump (BR-ID-22 细则; 04 §7 30111): a missing installed is unknown.
 * Installed or unknown → the universal link first, the system-browser page as fallback;
 * not installed → the page only.
 */
function pddJump(
  authUrl: string,
  installed: UnionAuthUrlInput['installed'],
  expireAt: Date,
): AuthJumpPlan {
  const h5: AuthJumpStep = { type: 'h5', value: authUrl };
  const link: AuthJumpStep = { type: 'universal_link', value: authUrl };
  const notInstalled = installed === 'false';
  return {
    primary: notInstalled ? h5 : link,
    fallbacks: notInstalled ? [] : [h5],
    expire_at: expireAt.toISOString(),
  };
}

export function createUnionAuthUrl(options: UnionAuthUrlOptions): UnionAuthUrlService {
  const { db, clock, callerContext, config, appEnv, authApps, logger } = options;

  async function bindingStatus(
    appId: string,
    userId: string,
    platform: 'taobao' | 'pdd',
  ): Promise<string> {
    const rows = await db
      .selectFrom('union_bindings')
      .select('status')
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .where('platform', '=', platform)
      .execute();
    // The projection of the authorization page (BR-ID-17 细则「授权管理页」): the unreleased
    // binding when there is one, else released when a released row exists, else unbound.
    const unreleased = rows.find((row) => (UNRELEASED as readonly string[]).includes(row.status));
    if (unreleased !== undefined) return unreleased.status;
    return rows.some((row) => row.status === 'released') ? 'released' : 'unbound';
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

  /** BR-ID-24 ④: the site's authorization of this platform is usable (not expired). */
  async function siteAuthAvailable(appId: string, platform: 'taobao' | 'pdd'): Promise<boolean> {
    const row = await db
      .selectFrom('union_accounts')
      .select('id')
      .where('app_id', '=', appId)
      .where('platform', '=', platform)
      .where('auth_status', '<>', 'expired')
      .executeTakeFirst();
    return row !== undefined;
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
    const status = await bindingStatus(appId, userId, platform);
    // A blocked binding answers 30153 before anything else (BR-ID-24 ④ keeps it for blocked).
    if (status === 'blocked') {
      // A banned user has no session (BR-ID-31); one still reaching here gets no state either.
      if (await userBanned(appId, userId)) return fail(10001, input.traceId);
      return fail(30153, input.traceId);
    }
    if (!(await siteAuthAvailable(appId, platform))) {
      return fail(status === 'invalid' ? 30102 : 30101, input.traceId, {
        reason: 'auth_unavailable',
      });
    }

    const methods = platform === 'taobao' ? await configuredMethods(appId, client) : null;
    const refs = methods === null ? null : await appRefs(appId, client, methods);

    const now = clock.now();
    // A second reading of the injected clock, moved by the TTL (no `new Date` outside the clock).
    const expireAt = clock.now();
    expireAt.setTime(now.getTime() + STATE_TTL_MS);
    const state = newState();
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

    const authUrl = syntheticAuthUrl(platform, state);
    const data =
      methods === null
        ? { auth_url: authUrl, state, auth_jump: pddJump(authUrl, input.installed, expireAt) }
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
