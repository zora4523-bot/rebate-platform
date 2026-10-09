// Admin console authentication (F1-06k; 08 BR-ID-34): the /admin/v1/auth routes, the admin
// entry's request check (whitelist + admin_token) and the CORS policy bootstrap installs. Loaded on
// the admin entry only (app.module).
//
// Without a database, Redis or the field cipher (isolated HTTP unit tests, an entry started
// without them) the routes still register and every request that needs them fails closed (50001).
// Configuration (platform/config/admin-auth.ts): local / test without ADMIN_TOKEN_SIGNING_KEY sign
// with a random key per process and, without ADMIN_IP_ALLOWLIST, allow loopback sources only;
// staging / prod without the key or the whitelist refuse to start when the entry initialises.
import { type DynamicModule, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  FIELD_CRYPTO,
  REDIS,
  SENSITIVE_KEYS,
  type AdminAuthConfig,
  type AppConfig,
  type Clock,
  type FieldCrypto,
  type RedisHandle,
  type RedisNamespace,
  type RequestCheck,
} from '../platform/index.ts';
import { createAdminRequestCheck } from './application/admin-check.ts';
import { createAdminAuthService, type AdminAuthService } from './application/admin-login.ts';
import { adminTokenKey, createAdminTokens, type AdminTokens } from './application/admin-tokens.ts';
import { ADMIN_AUTH, ADMIN_CHECK, ADMIN_HTTP_POLICY } from './application/tokens.ts';
import { createIpAllowlist } from './domain/login-policy.ts';
import { createTotpVerifier } from './domain/totp.ts';
import { AdminAuthController } from './http/admin/auth.controller.ts';
import { createAdminAccounts, type AdminAccounts } from './infra/admin-accounts.ts';
import { createAdminSessions, type AdminSessions } from './infra/admin-sessions.ts';
import { createLoginTickets } from './infra/login-tickets.ts';
import { createPgTotpReplayStore } from './infra/totp-replay-pg.ts';

/** What bootstrap needs to answer the console's CORS requests on the admin entry. */
export interface AdminHttpPolicy {
  /** Exact origin of the console front end; null: no CORS headers at all. */
  readonly corsOrigin: string | null;
  /** The admin whitelist over the client address (`request.ip`). */
  readonly allows: (ip: string | undefined) => boolean;
}

const ADMIN_TOKENS = Symbol('ADMIN_TOKENS');
const ADMIN_STORES = Symbol('ADMIN_STORES');
const ADMIN_STARTUP = Symbol('ADMIN_STARTUP');
const ADMIN_ALLOWLIST = Symbol('ADMIN_ALLOWLIST');
const REDIS_NAMESPACE = 'admin-auth';
/** Authenticator issuer, as the F1-06c bootstrap command shows it. */
const ISSUER = 'Couli Admin';

/** The stores the use cases and the check share; each call fails closed without its backend. */
interface AdminStores {
  readonly redis: () => RedisNamespace;
  readonly accounts: () => AdminAccounts;
  readonly sessions: () => AdminSessions;
}

/** A namespace that is looked up at every command, so a missing Redis fails per request. */
function lazyNamespace(get: () => RedisNamespace): RedisNamespace {
  return {
    get: (key) => get().get(key),
    set: (key, value, ttlSeconds) => get().set(key, value, ttlSeconds),
    eval: (script, options) => get().eval(script, options),
  };
}

function unavailable(what: string): never {
  throw new Error(`admin auth: no ${what} configured for this process`);
}

/** Staging / prod refuse to start without the signing key and the whitelist (ruling §9.2 #5, #6). */
function startupProblems(config: AppConfig): string[] {
  if (config.appEnv !== 'staging' && config.appEnv !== 'prod') return [];
  const admin: AdminAuthConfig | null = config.adminAuth ?? null;
  const problems: string[] = [];
  if (admin?.tokenSigningKey == null) {
    problems.push(`ADMIN_TOKEN_SIGNING_KEY: must be set when APP_ENV=${config.appEnv}`);
  }
  if (admin?.ipAllowlist == null) {
    problems.push(`ADMIN_IP_ALLOWLIST: must be set when APP_ENV=${config.appEnv}`);
  }
  return problems;
}

@Module({})
export class AdminAuthModule {
  static forRoot(): DynamicModule {
    return {
      module: AdminAuthModule,
      controllers: [AdminAuthController],
      providers: [
        {
          provide: ADMIN_STARTUP,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) => ({
            // Init, not construction: an entry built without init (tests of other wiring) starts.
            onModuleInit(): void {
              const problems = startupProblems(config);
              if (problems.length > 0) {
                throw new Error(`admin entry configuration:\n- ${problems.join('\n- ')}`);
              }
            },
          }),
        },
        {
          provide: ADMIN_TOKENS,
          inject: [APP_CONFIG, CLOCK],
          useFactory: (config: AppConfig, clock: Clock): AdminTokens =>
            createAdminTokens({
              key: adminTokenKey(config.adminAuth?.tokenSigningKey ?? null),
              clock,
            }),
        },
        {
          provide: ADMIN_ALLOWLIST,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) =>
            createIpAllowlist(config.adminAuth?.ipAllowlist ?? null),
        },
        {
          provide: ADMIN_STORES,
          inject: [CLOCK, { token: DB, optional: true }, { token: REDIS, optional: true }],
          useFactory: (clock: Clock, db?: Kysely<Database>, redis?: RedisHandle): AdminStores => {
            const namespace = lazyNamespace(() =>
              redis === undefined ? unavailable('Redis') : redis.namespace(REDIS_NAMESPACE),
            );
            const accounts =
              db === undefined
                ? undefined
                : createAdminAccounts({ db, clock, sensitiveKeys: SENSITIVE_KEYS });
            const sessions = createAdminSessions({ redis: namespace, clock });
            return {
              redis: () => namespace,
              accounts: () => accounts ?? unavailable('database'),
              sessions: () => sessions,
            };
          },
        },
        {
          provide: ADMIN_AUTH,
          inject: [
            APP_CONFIG,
            CLOCK,
            ADMIN_TOKENS,
            ADMIN_STORES,
            { token: DB, optional: true },
            { token: FIELD_CRYPTO, optional: true },
          ],
          useFactory: (
            config: AppConfig,
            clock: Clock,
            tokens: AdminTokens,
            stores: AdminStores,
            db?: Kysely<Database>,
            crypto?: FieldCrypto,
          ): AdminAuthService => {
            if (db === undefined || crypto === undefined) {
              const refuse = (): Promise<never> =>
                Promise.reject(new Error('admin auth: needs the database and the field cipher'));
              return {
                login: refuse,
                changeInitialPassword: refuse,
                bindingSecret: refuse,
                bindTotp: refuse,
                verifyTotp: refuse,
                logout: refuse,
              };
            }
            return createAdminAuthService({
              clock,
              accounts: stores.accounts(),
              tickets: createLoginTickets({ redis: stores.redis(), clock }),
              sessions: stores.sessions(),
              tokens,
              totp: createTotpVerifier({
                clock,
                crypto,
                replay: createPgTotpReplayStore({ db }),
                digits: 6,
              }),
              crypto,
              issuer: config.appEnv === 'prod' ? ISSUER : `${ISSUER} ${config.appEnv}`,
            });
          },
        },
        {
          provide: ADMIN_CHECK,
          inject: [CLOCK, ADMIN_TOKENS, ADMIN_STORES, ADMIN_ALLOWLIST],
          useFactory: (
            clock: Clock,
            tokens: AdminTokens,
            stores: AdminStores,
            allows: (ip: string | undefined) => boolean,
          ): RequestCheck =>
            createAdminRequestCheck({
              clock,
              allows,
              tokens,
              sessions: stores.sessions,
              accounts: stores.accounts,
            }),
        },
        {
          provide: ADMIN_HTTP_POLICY,
          inject: [APP_CONFIG, ADMIN_ALLOWLIST],
          useFactory: (
            config: AppConfig,
            allows: (ip: string | undefined) => boolean,
          ): AdminHttpPolicy => ({ corsOrigin: config.adminAuth?.corsOrigin ?? null, allows }),
        },
      ],
      exports: [ADMIN_CHECK, ADMIN_HTTP_POLICY],
    };
  }
}
