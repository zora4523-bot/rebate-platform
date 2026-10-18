import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import {
  AdminRiskState,
  createRiskStateService,
  type AdminRiskStateOptions,
} from '../../../../apps/api/src/modules/risk/index.ts';
import {
  REDIS,
  EVENT_BUS,
  type RedisHandle,
  type EventBus,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { blockForBan, restoreAfterUnban } from '../../../../apps/api/src/modules/linking/index.ts';
import { revokeSessionsByUser } from '../../../../apps/api/src/modules/identity/application/revoke-sessions.ts';
import { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import {
  createTokenService,
  createTokenCheck,
} from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSessionLookup } from '../../../../apps/api/src/modules/identity/infra/session-lookup.ts';
import { createRefreshService } from '../../../../apps/api/src/modules/identity/application/refresh.ts';
import { keys, request, HEADERS } from '../../identity/token/kit.ts';
import { body, type Action, type Scenario } from './kit.ts';

export function serviceOptions(s: Scenario): AdminRiskStateOptions {
  const redis = s.f.app.get<RedisHandle>(REDIS);
  const events = s.f.app.get<EventBus>(EVENT_BUS);
  return {
    db: s.h.db,
    clock: s.f.clock,
    events,
    redis,
    logger: s.f.overrides.logger,
    riskState: createRiskStateService({ db: s.h.db, clock: s.f.clock, events, redis }),
    auditOn: (trx) => createAuditWriter({ db: trx, clock: s.f.clock }),
    revokeSessions: (trx, input) => revokeSessionsByUser(trx, input, s.f.clock),
    blockForBan,
    restoreAfterUnban,
  };
}
export function command(s: Scenario, action: Action = 'ban', version: number | null = null) {
  return {
    appId: s.appId,
    userId: s.userId,
    adminId: s.a.id,
    adminUsername: s.a.username,
    ip: '127.0.0.1',
    body: body(action, version),
  };
}
export function service(s: Scenario, patch: Partial<AdminRiskStateOptions> = {}) {
  return new AdminRiskState({ ...serviceOptions(s), ...patch });
}
export async function userSessions(s: Scenario) {
  const tokens = createTokenService({ clock: s.f.clock, keys: keys() });
  const redis = s.f.app.get<RedisHandle>(REDIS);
  const issue = async () => {
    const deviceId = randomUUID();
    await s.h.db
      .insertInto('devices')
      .values({
        id: deviceId,
        app_id: s.appId,
        device_hash: randomUUID().replaceAll('-', '').repeat(2),
        id_source: 'idfv',
        install_secret_cipher: Buffer.from('fixture'),
        platform: 'ios',
        app_version: '2.0.0',
        last_seen_at: s.f.clock.now(),
      })
      .execute();
    const pair = await s.h.db
      .transaction()
      .execute((trx) =>
        createSession(
          trx,
          { app_id: s.appId, uid: s.userId, device_id: deviceId, scp: 'full' },
          { clock: s.f.clock, tokens },
        ),
      );
    return { ...pair, deviceId };
  };
  const first = await issue();
  const second = await issue();
  const guard = createTokenCheck({ tokens, sessions: createSessionLookup(s.h.db) });
  const access = (pair: typeof first) =>
    guard(
      request(
        { method: 'POST', path: '/v1/auth/logout' },
        {
          ...HEADERS,
          'x-app-id': s.appId,
          'x-device-id': pair.deviceId,
          authorization: `Bearer ${pair.access_token}`,
        },
      ),
    );
  const refresh = (pair: typeof first) =>
    createRefreshService({
      db: s.h.db,
      clock: s.f.clock,
      tokens,
      crypto: s.h.fields,
      redis,
      versions: { minSupportedVersion: async () => null },
      logger: s.f.overrides.logger,
    }).refresh({
      refresh_token: pair.refresh_token,
      verifiedDevice: { appId: s.appId, deviceId: pair.deviceId },
      platform: 'ios',
      channel: 'appstore',
      version: '2.0.0',
    });
  return { first, second, issue, access, refresh };
}

/** Observe real Lua/Redis, without reimplementing its max-version algorithm in the test. */
export function observeRedis(handle: RedisHandle) {
  const namespaces = new Map<string, ReturnType<RedisHandle['namespace']>>();
  const gets = vi.fn(async (name: string, key: string) => handle.namespace(name).get(key));
  const writes = vi.fn(
    async (
      name: string,
      script: string,
      options: Parameters<ReturnType<RedisHandle['namespace']>['eval']>[1],
    ) => handle.namespace(name).eval(script, options),
  );
  const redis: RedisHandle = {
    ...handle,
    namespace(name) {
      let ns = namespaces.get(name);
      if (ns === undefined) {
        ns = {
          ...handle.namespace(name),
          get: (key) => gets(name, key),
          eval: (script, options) => writes(name, script, options),
        };
        namespaces.set(name, ns);
      }
      return ns;
    },
  };
  return { redis, gets, writes };
}
