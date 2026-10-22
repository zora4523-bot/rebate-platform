import { type DynamicModule, type Provider, HttpException, Module, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { DB as Database } from '@couli/db';
import { ProductKeyUnderivable, deriveProductKey, type UnionProductPayload } from '@couli/domain';
import type { Kysely } from 'kysely';
import {
  ADMIN_CHECK,
  AdminAuthModule,
  AdminModule,
  ExportWorkerModule,
  createAdminDisplayNameReader,
  createAuditWriter,
} from './modules/admin/index.ts';
import { AgentModule } from './modules/agent/index.ts';
import {
  CatalogModule,
  GovernedUnion,
  PRODUCT_CACHE_NAMESPACE,
  LinkRegistrar,
  RebateQuoter,
  createCatalog,
  createDbCatalogProductReader,
  createDemoRebateQuoter,
  createItemRefService,
  processItemRefCipher,
  type CatalogCardEntry,
  type CatalogConfigReader,
  type CatalogWarning,
  type RegisterLinkInput,
} from './modules/catalog/index.ts';
import {
  COMMISSION_QUOTE_CONFIG_KEYS,
  createCommissionRebateQuoter,
  createRuleSetReader,
  type RuleSetReader,
} from './modules/commission/index.ts';
import {
  ContentAdminModule,
  ContentPublicModule,
  createContentReader,
  type ContentReader,
  type PageAudienceReads,
} from './modules/content/index.ts';
// The configuration registry is pure data that content's index.ts does not export yet; the audit
// search only needs its key → permission column (B1-34a).
// TODO(规划/11 §2.3): 配置注册表改从 content 的 index.ts 导入 — blocked on content 任务补该导出（不在 B1-34a 路径内）
import { configRegistry } from './modules/content/domain/config-registry.ts';
import { HealthModule } from './modules/health/index.ts';
import {
  GrowthModule,
  appendLevelChange,
  createFirstAppLoginReview,
  createInviteBinder,
  createInviteRewardBudgetReader,
  createInviteRewardExpiry,
  createInviteRewardPayout,
  createInviteRewardQualifier,
  createInviteRewardScanner,
  inviteRewardScannerToken,
  createLandingInviteBinder,
  createMyInviteReader,
  createParentRelationReader,
  createRegistrationInviteBinding,
  type ParentRelationReader,
  type InviteBinder,
  type InviteBinderDeps,
  type MyInviteReader,
  type InviteRewardQualifier,
  type InviteRewardScanner,
} from './modules/growth/index.ts';
import {
  IdentityAdminModule,
  IdentityModule,
  createExportUsersReader,
  IdentityWorkerModule,
  IdentityDeletionExpiryModule,
  ME_READ_PORTS,
  createMaskedPhoneReader,
  CONSENT_SIGNATURE_CHECK,
  TOKEN_CHECK,
  STEP_UP_CHECK,
  IDENTITY_LEVEL_CHECKS,
  PRIVACY_CONSENT_CHECKS,
  DELETION_STAGE_CHECKS,
  createRealnameReader,
  createRealnameStatusReader,
  createSmsSender,
  createThirdPartyIdentity,
  smsSenderToken,
  createIdentityAttrCodeReader,
  isRecordConsentRoute,
  createIdentityCallerContext,
  createAiConsentReader,
  createAgentCallerReader,
  createIdentityViewerContext,
  createSameDeviceLoginReader,
  createUserLevelReader,
  createInviteBackfillActivityReader,
  createInviteLoginDevicesReader,
  createDeletionStageReader,
  createOrderUserReader,
  createUserDeletionStatusReader,
  createInviteRewardLoginIpsReader,
  createInviteRewardDeletedPhoneReader,
  revokeSessionsByUser,
  unbindRevoked,
  type IdentityAttrCodeReader,
  type IdentityConfigReader,
  type IdentityContext,
  type LaborAgreementConfigReader,
  type DeletionBalanceReader,
  type DeletionCalendarConfigReader,
  type WithdrawalInFlightReader,
  type WithdrawalNonTerminalReader,
  type LandingInvitePort,
  type LandingRegisterConfigReader,
  type IdentityRequest,
  type FirstAppLoginReview,
  type InitialLevelLog,
  type RegistrationInviteBindingPort,
  type SessionPushTokens,
  type UserLevelReader,
  type IdentityLevelChecks,
  type PrivacyConsentChecks,
  type DeletionStageChecks,
  type PrivacyConsentOptions,
  type AccountAssetsPort,
  type AccountRiskPort,
  type MeReadPorts,
  type MeUnionBindingStatus,
  type PayoutAccountConfigPort,
} from './modules/identity/index.ts';
import { LedgerModule, createLedger } from './modules/ledger/index.ts';
import {
  LINK_LANDING_PORTS,
  LINK_OPEN_PORTS,
  LINK_REGISTRATIONS,
  LinkingAdminModule,
  LinkingModule,
  createOrderBindingReader,
  createClaimEntryReader,
  createClaimEvidenceReader,
  createLinkLogMomentReader,
  createOrderSourceReader,
  blockForBan,
  restoreAfterUnban,
  createOrderLinkReader,
  createPendingAttemptStore,
  createUnionAuthReads,
  type UnionAuthReads,
  createUnavailableAttrCodeReader,
  inOpenReads,
  loadLinkOpenApps,
  openScopedConfig,
  openScopedReader,
  type LinkConvertPorts,
  type LinkLandingPorts,
  type LinkOpenPorts,
  type LinkOpenQuoteReads,
  type LinkOpenReadPlan,
  type LinkRegistrations,
  needsTaobaoReauth,
} from './modules/linking/index.ts';
import {
  NotificationModule,
  bindPushTokensForSession,
  unbindPushTokensForSession,
} from './modules/notification/index.ts';
import {
  OrdersAdminModule,
  OrdersModule,
  type AdminClaimPorts,
  createInviteRewardOrderFacts,
  type ClaimEvidenceFactory,
  createOrderSourcePorts,
  type OrderSourcePorts,
  type OrdersWorkerOptions,
} from './modules/orders/index.ts';
import {
  ParsingLinkRegistrars,
  ParsingModule,
  createParsing,
  parseUrl,
  type ParseScene,
} from './modules/parsing/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  FIELD_CRYPTO,
  EVENT_BUS,
  PlatformModule,
  REDIS,
  ROOT_LOGGER,
  SENSITIVE_KEYS,
  createMemoryQuotaLimiter,
  quotaShares,
  systemScheduler,
  type AppConfig,
  type Clock,
  type FieldCrypto,
  type EventBus,
  type IdempotencyPostMissCheck,
  type PlatformOptions,
  type RedisHandle,
  type RootLogger,
  REQUEST_CHECKS,
  type RequestCheck,
  type RequestCheckPlan,
  isContractSignedRoute,
  isHttpEntry,
} from './modules/platform/index.ts';
import {
  RiskAdminModule,
  RiskModule,
  RiskScanModule,
  SIGNATURE_CHECK,
  createBlocklistService,
  createInviteRelationHitWriter,
  createSameDeviceAccountsCheck,
  createRiskStateService,
  createDeviceRegistrationRisk,
  createSmsRisk,
  riskStateServiceToken,
  ephemeralSmsRiskIndex,
  unkeyedDeviceRegistrationIndex,
  type DeviceRegistrationRisk,
  type SmsRisk,
  createRateLimitThresholdReader,
  type MinimumVersionReaders,
  type RateLimitThresholdReaders,
  type BlocklistService,
  type RiskStateService,
} from './modules/risk/index.ts';
import {
  REGISTERED_PLATFORMS,
  UNION_ENDPOINTS,
  UNION_REGISTRY,
  UnionModule,
  createGovernedAdapter,
  type RegisteredPlatform,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionMode,
  type UnionRegistry,
} from './modules/union/index.ts';

/**
 * The request check plan bootstrap installs before Fastify parses a body (规划/08 BR-ID-01):
 * on the `api` entry, which serves every x-signed operation, ① the request signature first
 * (bootstrap refuses a plan where it is not), then identity's consent signature check (B1-02zc:
 * recordConsent's clipboard_auto_import requests, signed over the raw body although the operation
 * is x-signed false), then identity's token stages ② ③. They run on every matched route; only the
 * contract x-signed routes and recordConsent have their body buffered before the checks (the
 * signature covers it), so ② ③ answer any other unsigned route from its headers alone, before its
 * body is read or validated, and its body keeps Fastify's own handling. ① skips unsigned routes;
 * ② ③ act by the route's contract x-auth and leave routes outside the contract alone.
 * The factory stays synchronous (its async dependencies are providers of their own).
 * On the `admin` entry (F1-06k) the only check is admin's: the whitelist on every /admin/v1
 * route, then the admin_token on the contract admin / super routes (BR-ID-34); it reads headers
 * and the client address only, so no body is buffered.
 * The stream pre-parsing plan installs identity's token stages ② ③: Agent routes are unsigned
 * and x-auth optional. Risk's ordered guards run afterwards, as on api, including minimum
 * versions, restricted sessions and bans. The admin entry covers its levels through its check.
 */
function requestChecks(options: PlatformOptions): Provider {
  if (options.entry === 'api') {
    return {
      provide: REQUEST_CHECKS,
      inject: [SIGNATURE_CHECK, CONSENT_SIGNATURE_CHECK, TOKEN_CHECK],
      useFactory: (
        signature: RequestCheck,
        consentSignature: RequestCheck,
        token: RequestCheck,
      ): RequestCheckPlan => ({
        // ① signature; then recordConsent's clipboard_auto_import signature (B1-02zc: the same
        // checks over the raw bytes on that one unsigned route), still before ② ③.
        checks: [signature, consentSignature, token],
        // The x-signed routes, plus recordConsent alone among the unsigned ones (its
        // clipboard_auto_import requests are signed over the raw body, B1-02zc).
        bufferWhen: (method, template) =>
          isContractSignedRoute(method, template) || isRecordConsentRoute(method, template),
      }),
    };
  }
  if (options.entry === 'admin') {
    return {
      provide: REQUEST_CHECKS,
      inject: [ADMIN_CHECK],
      useFactory: (admin: RequestCheck): RequestCheckPlan => ({
        checks: [admin],
        bufferWhen: () => false,
      }),
    };
  }
  if (options.entry === 'stream') {
    return {
      provide: REQUEST_CHECKS,
      inject: [TOKEN_CHECK],
      useFactory: (token: RequestCheck): RequestCheckPlan => ({
        checks: [token],
        bufferWhen: () => false,
      }),
    };
  }
  return { provide: REQUEST_CHECKS, useValue: { checks: [] } satisfies RequestCheckPlan };
}

/** Identity services and checks without its /v1 routes, which belong to api. */
function streamIdentityModule(): DynamicModule {
  return {
    ...IdentityModule.forRoot({
      config: {
        inject: [CLOCK, { token: DB, optional: true }],
        useFactory: (clock: Clock, db?: Kysely<Database>): IdentityConfigReader | null =>
          db === undefined ? null : createContentReader({ db, clock }),
      },
    }),
    controllers: [],
  };
}

/**
 * Stream shares api's minimum-version / restricted-session and ban guards, without risk's
 * appeals routes. Agent owns admission and rate limits (BR-AI-23); no api rate-limit mapping or
 * identity level / step-up checks are supplied to this entry.
 * Stage ⑥ (deletion cooling / processing, B1-15m) is the only check in both lists: after ⑤, it
 * refuses /v1/agent/ writes carrying a verified token with 10007 (BR-ID-01, BR-ID-27); ⑦ ⑧ ⑨ and
 * step-up stay off this entry.
 */
function streamRiskModule(
  identity: DynamicModule,
  contentReader: SharedContentReader,
): DynamicModule {
  const noRateLimits = {
    groupFor: async () => null,
    rules: async () => [],
  };
  return {
    ...RiskModule.forRoot({
      imports: [identity],
      beforeRateLimit: {
        inject: [DELETION_STAGE_CHECKS],
        useFactory: (deletion: DeletionStageChecks) => [deletion.postMiss],
      },
      beforeRateLimitGuards: {
        inject: [DELETION_STAGE_CHECKS],
        useFactory: (deletion: DeletionStageChecks) => [deletion.guard],
      },
      minimumVersions: {
        inject: [CLOCK, { token: DB, optional: true }],
        useFactory: (clock: Clock, db?: Kysely<Database>): MinimumVersionReaders | null =>
          db === undefined
            ? null
            : {
                pooled: contentReader(db, clock),
                on: (handle) => createContentReader({ db: handle, clock }),
              },
      },
      rateLimit: {
        thresholds: {
          useFactory: (): RateLimitThresholdReaders => ({
            pooled: noRateLimits,
            on: () => noRateLimits,
          }),
        },
      },
    }),
    controllers: [],
  };
}

/**
 * B1-13e: content's reader on the caller's handle (B1-11d precedent): a plain read each time,
 * never a second pooled connection while the caller's transaction is held. Shared by the api
 * entry's IdentityModule and the worker's IdentityWorkerModule (B1-13g).
 */
const payoutAccountConfig = {
  inject: [CLOCK],
  useFactory: (clock: Clock): PayoutAccountConfigPort => ({
    configValue: (appId, key, handle) =>
      createContentReader({ db: handle, clock }).configValue(appId, key),
  }),
};

/**
 * The user's withdrawals as identity's deletion flows see them, on the caller's transaction:
 * POST /v1/me/deletion asks hasInFlight (B1-15d, D10-97: 30412), the worker's cooling-period
 * expiry asks hasNonTerminal (B1-15f, BR-ID-27: any non-terminal one, ban-frozen included, defers
 * processing). The payout module does not exist yet, so there is truthfully none; B2-05 replaces
 * both methods together.
 */
const deletionWithdrawals = {
  inject: [],
  useFactory: (): WithdrawalInFlightReader & WithdrawalNonTerminalReader => ({
    // TODO(规划/11 §2.3): 在途提现读 payout 模块 — blocked on B2-05
    hasInFlight: () => Promise.resolve(false),
    // TODO(规划/11 §2.3): 未到终态的提现（含封禁冻结）读 payout 模块 — blocked on B2-05
    hasNonTerminal: () => Promise.resolve(false),
  }),
};

/**
 * The user's available_fen for the deletion flows (B1-15d 30416 on the api entry; B1-15f's expiry
 * re-check on the worker): the ledger's getBalances on the caller's transaction (bigint fen; no
 * account → 0n).
 */
const deletionBalance = {
  inject: [CLOCK],
  useFactory: (clock: Clock): DeletionBalanceReader => {
    const ledger = createLedger({ clock });
    return {
      async availableFen(trx, input) {
        const balances = await ledger.getBalances(trx, {
          appId: input.appId,
          userIds: [input.userId],
        });
        const own = balances.find(
          (row) => row.app_id === input.appId && row.user_id === input.userId,
        );
        return own === undefined ? 0n : own.available_fen;
      },
    };
  },
};

/**
 * B1-15f: the working-day calendar of the deletion overdue alarm (calendar.cn_holidays.<year>,
 * calendar.cn_makeup_workdays.<year>) through content's reader; without a database there is no
 * expiry to read it (every read answers null).
 */
const deletionCalendarConfig = {
  inject: [CLOCK, { token: DB, optional: true }],
  useFactory: (clock: Clock, db?: Kysely<Database>): DeletionCalendarConfigReader => {
    if (db === undefined) return { configValue: () => Promise.resolve(null) };
    const reader = createContentReader({ db, clock });
    return { configValue: (appId, key) => reader.configValue(appId, key) };
  },
};

/**
 * The identity module of the `api` entry. Its configuration port (sms.blocked_prefixes, BR-ID-05;
 * the minimum supported version of the session scope, BR-ID-01 细则「受限会话」) is content's cached
 * reader of config_items and app_versions: content implements the port's shape without importing
 * identity (same assembly as the risk ports, F1-02b). No database handle (isolated HTTP unit
 * tests): no reader, and the SMS code route answers 50001.
 * Its blocklist port is risk's blocklist service (B1-03d: SMS send, SMS login before creating an
 * account, the same-device limit), built here so identity and risk stay plain ports to each
 * other; without a database or field cipher there is none.
 * Its device registration ports are risk's (B1-03f: device.ip_register_per_hour and
 * device.hash_hot_alert_count through content's configValue, Redis sets keyed by the field
 * cipher's blind index), built through risk's index.ts; without Redis they refuse (42901) and the
 * hot-hash count is a no-op; without a database the thresholds are the defaults.
 * Its SMS send risk is risk's (B1-03g: sms.device_distinct_phones_per_hour, sms.ip_sends_per_hour,
 * the per-IP new-account limit and the daily budget alert through content's configValue; phones and
 * IPs as the field cipher's blind index, a process-local key in local / test without a keyring);
 * without Redis every send is refused (42901).
 * Its push token port is notification's binding and conditional unbinding commands (B1-12b,
 * BR-ID-07 细则「推送令牌与会话」), assembled here over the Clock so identity never imports
 * notification (and notification nothing of identity): login binds, logout, the refresh reuse
 * revocation and the revocation entries by user / by device unbind, in the session's transaction.
 * Its real-name status port (stage ⑨, B1-02za) is the default reader (none) until B1-13d.
 * Its invite binding port (BR-INV-06, B1-11d) is growth's binder on the register channel, over
 * config_items read on the registration transaction, Redis, the field cipher's blind index, identity's login-device and
 * order / claim readers and risk's fresh state read, each bound to the registration transaction;
 * without a database, Redis or the field cipher there is none (invite_bind { failed, 50001 }).
 * Its first App login review (BR-INV-09, B1-11f) is growth's landing-bind same-device review over
 * identity's login-device reader and risk's invite-relation hit writer, all on the login
 * transaction; the SMS and the third-party login both run it.
 */
function identityModule(contentReader: SharedContentReader): DynamicModule {
  return IdentityModule.forRoot({
    accountAssets: {
      useFactory: (): AccountAssetsPort => ({
        async countOrders(db, account) {
          const row = await db
            .withSchema('app')
            .selectFrom('orders')
            .select((eb) => eb.fn.countAll<string>().as('count'))
            .where('app_id', '=', account.app_id)
            .where('user_id', '=', account.user_id)
            .executeTakeFirstOrThrow();
          return Number(row.count);
        },
        // TODO(规划/11 §2.3): 并号条件读找回申请 — blocked on B1-10 找回申请
        hasClaims: () => Promise.resolve(false),
        // TODO(规划/11 §2.3): 并号条件读余额流水 — blocked on ledger 模块（B2）
        hasLedgerEntries: () => Promise.resolve(false),
      }),
    },
    accountRisk: {
      inject: [CLOCK, { token: EVENT_BUS, optional: true }],
      useFactory: (clock: Clock, events?: EventBus): AccountRiskPort | null =>
        events === undefined
          ? null
          : {
              async isBanned(db, account) {
                // Bind the exported reader to the caller's transaction: no second connection.
                const risk = createRiskStateService({ db, clock, events });
                const snapshot = await risk.readRiskState(account, { fresh: true });
                if (snapshot.state === 'banned') return true;
                if (snapshot.state !== 'appealing') return false;
                // Reuse risk's exported request check for the pre-appeal state. This is only a
                // read probe; its synthetic principal is never used for authentication or writes.
                try {
                  await risk.checkRequest(
                    {
                      id: '',
                      method: 'POST',
                      routeOptions: { url: '/v1/me/phone' },
                      headers: {},
                      principal: {
                        uid: account.user_id,
                        app_id: account.app_id,
                        sid: '',
                        device_id: '',
                        scp: 'full',
                      },
                    },
                    db,
                  );
                  return false;
                } catch (error) {
                  if (error instanceof HttpException) {
                    const body = error.getResponse();
                    if (typeof body === 'object' && 'code' in body && body.code === 10006)
                      return true;
                  }
                  throw error;
                }
              },
            },
    },
    thirdPartyIdentity: {
      inject: [APP_CONFIG, ROOT_LOGGER],
      useFactory: (config: AppConfig, logger: RootLogger) =>
        createThirdPartyIdentity(config.appEnv, logger),
    },
    config: {
      inject: [CLOCK, { token: DB, optional: true }],
      useFactory: (clock: Clock, db?: Kysely<Database>): IdentityConfigReader | null =>
        db === undefined ? null : createContentReader({ db, clock }),
    },
    payoutAccountConfig,
    blocklist: {
      inject: [
        CLOCK,
        ROOT_LOGGER,
        { token: DB, optional: true },
        { token: FIELD_CRYPTO, optional: true },
      ],
      useFactory: (
        clock: Clock,
        logger: RootLogger,
        db?: Kysely<Database>,
        crypto?: FieldCrypto,
      ): BlocklistService | null =>
        db === undefined || crypto === undefined
          ? null
          : createBlocklistService({ db, clock, crypto, logger }),
    },
    deviceRegistration: {
      inject: [
        CLOCK,
        ROOT_LOGGER,
        { token: DB, optional: true },
        { token: REDIS, optional: true },
        { token: FIELD_CRYPTO, optional: true },
      ],
      useFactory: (
        clock: Clock,
        logger: RootLogger,
        db?: Kysely<Database>,
        redis?: RedisHandle,
        crypto?: FieldCrypto,
      ): DeviceRegistrationRisk =>
        createDeviceRegistrationRisk({
          clock,
          logger,
          redis: redis ?? null,
          config:
            db === undefined
              ? { configValue: () => Promise.resolve(null) }
              : createContentReader({ db, clock }),
          crypto: crypto ?? unkeyedDeviceRegistrationIndex(),
        }),
    },
    smsRisk: {
      inject: [
        CLOCK,
        ROOT_LOGGER,
        { token: DB, optional: true },
        { token: REDIS, optional: true },
        { token: FIELD_CRYPTO, optional: true },
      ],
      useFactory: (
        clock: Clock,
        logger: RootLogger,
        db?: Kysely<Database>,
        redis?: RedisHandle,
        crypto?: FieldCrypto,
      ): SmsRisk =>
        createSmsRisk({
          clock,
          logger,
          redis: redis ?? null,
          config:
            db === undefined
              ? { configValue: () => Promise.resolve(null) }
              : createContentReader({ db, clock }),
          crypto: crypto ?? ephemeralSmsRiskIndex(),
          // B1-11g: the PG-authoritative per-IP attempts (no database → every send refused).
          db: db ?? null,
        }),
    },
    // Through identity's index.ts, as for the admin entry (one sender factory for both entries).
    smsSender: {
      inject: [APP_CONFIG, ROOT_LOGGER],
      useFactory: (config: AppConfig, logger: RootLogger) => createSmsSender(config.appEnv, logger),
    },
    pushTokens: {
      inject: [CLOCK],
      useFactory: sessionPushTokens,
    },
    // Stage ⑨'s real-name status port (B1-02za), also GET /v1/me's realname_status: app.realname
    // read on the caller's handle, uncached (B1-13d).
    realnameStatus: { useFactory: createRealnameStatusReader },
    // Stage ⑦ (B1-02zh): legal.privacy.min_version through content's reader. pooled: the shared
    // cached reader for the guard; on: a fresh reader over the idempotency claim's transaction for
    // the post-miss check (no second pooled connection while holding one). No database: null (⑦
    // not judged).
    privacyConsentConfig: {
      inject: [CLOCK, { token: DB, optional: true }],
      useFactory: (clock: Clock, db?: Kysely<Database>): PrivacyConsentOptions['config'] =>
        db === undefined
          ? null
          : {
              pooled: contentReader(db, clock),
              on: (handle) => createContentReader({ db: handle, clock }),
            },
    },
    // BR-WDR-31 (B1-13h): the labor agreement's configuration on the caller's handle (connection
    // or transaction), as inviteBinderDeps: a fresh reader per read, so no cache and no second
    // pooled connection; identity never reads config_items itself.
    // B1-11h: the landing registration's keys (legal versions, landing.ip_register_limit) on the
    // caller's handle, uncached, as laborAgreementConfig below.
    landingConfig: {
      inject: [CLOCK],
      useFactory: (clock: Clock): LandingRegisterConfigReader => ({
        configValue: (appId, key, handle) =>
          createContentReader({ db: handle, clock }).configValue(appId, key),
      }),
    },
    // B1-11h: growth's landing channel (precheck, binding) over the binder's read ports, each
    // bound to the landing transaction; without Redis, the field cipher or the event bus there is
    // none and the route answers 50001.
    landingInvite: {
      inject: [
        CLOCK,
        ROOT_LOGGER,
        { token: REDIS, optional: true },
        { token: FIELD_CRYPTO, optional: true },
        { token: EVENT_BUS, optional: true },
        { token: DB, optional: true },
      ],
      useFactory: (
        clock: Clock,
        logger: RootLogger,
        redis?: RedisHandle,
        crypto?: FieldCrypto,
        events?: EventBus,
        db?: Kysely<Database>,
      ): LandingInvitePort | null => {
        if (redis === undefined || crypto === undefined || events === undefined) {
          logger.info(
            {
              redis: redis !== undefined,
              field_crypto: crypto !== undefined,
              event_bus: events !== undefined,
            },
            'landing_invite_unassembled',
          );
          return null;
        }
        return createLandingInviteBinder({
          clock,
          logger,
          redis,
          crypto,
          ...growthReadPorts(clock, crypto, events),
          // BR-INV-24 ① (B1-35): the reward qualification in the landing transaction.
          ...(db === undefined
            ? {}
            : { inviteReward: inviteRewardQualifier(clock, logger, db, crypto) }),
        });
      },
    },
    laborAgreementConfig: {
      inject: [CLOCK],
      useFactory: (clock: Clock): LaborAgreementConfigReader => ({
        configValue: (appId, key, handle) =>
          createContentReader({ db: handle, clock }).configValue(appId, key),
      }),
    },
    initialLevelLog: {
      inject: [],
      useFactory: (): InitialLevelLog => ({
        append: (trx, input) =>
          appendLevelChange(trx, {
            ...input,
            from_level: null,
            source: 'register',
            operator: 'system',
            reason: null,
          }),
      }),
    },
    inviteBinding: {
      inject: [
        CLOCK,
        ROOT_LOGGER,
        { token: DB, optional: true },
        { token: REDIS, optional: true },
        { token: FIELD_CRYPTO, optional: true },
        { token: EVENT_BUS, optional: true },
      ],
      useFactory: (
        clock: Clock,
        logger: RootLogger,
        db?: Kysely<Database>,
        redis?: RedisHandle,
        crypto?: FieldCrypto,
        events?: EventBus,
      ): RegistrationInviteBindingPort | null => {
        if (
          db === undefined ||
          redis === undefined ||
          crypto === undefined ||
          events === undefined
        ) {
          logger.info(
            {
              db: db !== undefined,
              redis: redis !== undefined,
              field_crypto: crypto !== undefined,
              event_bus: events !== undefined,
            },
            'invite_binding_unassembled',
          );
          return null;
        }
        return createRegistrationInviteBinding(
          createInviteBinder(inviteBinderDeps(clock, logger, db, redis, crypto, events)),
          // The registration's client IP reaches the invite reward qualification (B1-35).
          { forwardClientIp: true },
        );
      },
    },
    withdrawalInFlight: deletionWithdrawals,
    deletionBalance,
    // Runs only on the login's own transaction (no handle of its own), so it needs no database.
    firstAppLoginReview: {
      inject: [CLOCK],
      useFactory: (clock: Clock): FirstAppLoginReview =>
        createFirstAppLoginReview({
          clock,
          loginDevices: createInviteLoginDevicesReader(),
          hitWriter: createInviteRelationHitWriter({ clock }),
        }),
    },
  });
}

/**
 * growth's binding core dependencies (B1-11d), shared by the register channel (identity's
 * inviteBinding port) and the backfill route (GrowthModule, B1-11e): config_items, identity's
 * login-device and order / claim readers and risk's fresh state read, each bound to the caller's
 * transaction (no second pooled connection while it is held), Redis and the field cipher's blind
 * index.
 */
function inviteBinderDeps(
  clock: Clock,
  logger: RootLogger,
  db: Kysely<Database>,
  redis: RedisHandle,
  crypto: FieldCrypto,
  events: EventBus,
): InviteBinderDeps {
  return {
    clock,
    logger,
    redis,
    crypto,
    loginDevices: createInviteLoginDevicesReader(),
    activity: (trx) => createInviteBackfillActivityReader(trx),
    ...growthReadPorts(clock, crypto, events),
    inviteReward: inviteRewardQualifier(clock, logger, db, crypto),
  };
}

/**
 * BR-INV-24 ① (B1-35): growth's invite reward qualifier for the three self-service binding
 * channels, over config_items read on the binding transaction (a fresh content reader per call,
 * as growthReadPorts) and the field cipher's blind index of the bind IP. The binders call it after
 * the relation log, under their own savepoint.
 */
function inviteRewardQualifier(
  clock: Clock,
  logger: RootLogger,
  db: Kysely<Database>,
  crypto: FieldCrypto,
): InviteRewardQualifier {
  return createInviteRewardQualifier({
    db,
    clock,
    logger,
    crypto,
    config: transactionConfig(clock),
  });
}

/** content's config_items reader bound to the caller's transaction (fresh per call, uncached). */
function transactionConfig(clock: Clock): InviteBinderDeps['config'] {
  return {
    configValue: (appId, key, trx) =>
      createContentReader({ db: trx, clock }).configValue(appId, key),
  };
}

@Module({})
class InviteRewardWorkerModule {}

/**
 * The worker's invite reward scanner (B1-35 §9.2 第 9 条; BR-INV-24 ④ and 「有效期」): growth's
 * payout over orders' fact port, identity's login-device / login-IP / retained-phone / deletion
 * readers, risk's fresh state read and BR-ID-37 check (configuration through content's reader on
 * the judging transaction), and growth's daily expiry. Without a database, the field cipher or the
 * event bus the provider is null and entry.ts starts no loop.
 * TODO(规划/11 §2.3): grantWriter（REWARD 凭证写入） — blocked on B2-16b; until then every payout
 * is deferred with a warn (invite_reward_writer_unavailable), nothing is released or paid.
 */
function inviteRewardWorkerModule(): DynamicModule {
  return {
    module: InviteRewardWorkerModule,
    global: true,
    providers: [
      {
        provide: inviteRewardScannerToken(),
        inject: [
          CLOCK,
          ROOT_LOGGER,
          { token: DB, optional: true },
          { token: FIELD_CRYPTO, optional: true },
          { token: EVENT_BUS, optional: true },
        ],
        useFactory: (
          clock: Clock,
          logger: RootLogger,
          db?: Kysely<Database>,
          crypto?: FieldCrypto,
          events?: EventBus,
        ): InviteRewardScanner | null => {
          if (db === undefined || crypto === undefined || events === undefined) {
            logger.info(
              {
                db: db !== undefined,
                field_crypto: crypto !== undefined,
                event_bus: events !== undefined,
              },
              'invite_reward_worker_unassembled',
            );
            return null;
          }
          const reads = growthReadPorts(clock, crypto, events);
          const base = { db, clock, logger, config: transactionConfig(clock) };
          const orders = createInviteRewardOrderFacts();
          const payout = createInviteRewardPayout({
            ...base,
            orders,
            crypto,
            loginDevices: createInviteLoginDevicesReader(),
            loginIps: createInviteRewardLoginIpsReader(),
            deletedPhone: createInviteRewardDeletedPhoneReader(),
            deletionStatus: createUserDeletionStatusReader({ db }),
            readRisk: reads.readRisk,
            verifiedBirthDate: reads.verifiedBirthDate,
            multiAccount: createSameDeviceAccountsCheck({
              clock,
              logger,
              logins: createSameDeviceLoginReader(),
              config: (handle) => createContentReader({ db: handle, clock }),
            }),
          });
          return createInviteRewardScanner({
            db,
            clock,
            logger,
            payout,
            expiry: createInviteRewardExpiry({ ...base, orders }),
          });
        },
      },
    ],
    exports: [inviteRewardScannerToken()],
  };
}

/**
 * The reads growth's binding core (B1-11d) and invite page (B1-11j) share, each on the caller's
 * transaction (no second pooled connection while it is held) and uncached: config_items through
 * content's reader (a fresh reader per call, so the value is never older than the transaction),
 * risk's fresh state read, identity's realname reader (B1-13d) for the verified birth date —
 * the decrypted name is dropped here and the birth date never reaches a log or a response — and
 * identity's deletion-stage reader (B1-15c) for the one subject on the trx (absent → none). Every
 * growth channel is assembled from here: register and backfill (inviteBinderDeps), landing and the
 * invite page.
 */
function growthReadPorts(
  clock: Clock,
  crypto: FieldCrypto,
  events: EventBus,
): Pick<InviteBinderDeps, 'config' | 'readRisk'> &
  Required<Pick<InviteBinderDeps, 'verifiedBirthDate' | 'readDeletionStage'>> {
  const realname = createRealnameReader(crypto);
  return {
    config: {
      configValue: (appId, key, trx) =>
        createContentReader({ db: trx, clock }).configValue(appId, key),
    },
    readRisk: (trx, subject) =>
      createRiskStateService({ db: trx, clock, events }).readRiskState(subject, {
        fresh: true,
      }),
    verifiedBirthDate: async (trx, subject) =>
      (await realname.verified(trx, subject))?.birth_date ?? null,
    readDeletionStage: async (trx, subject) =>
      (
        await createDeletionStageReader({ db: trx }).read(trx, {
          appId: subject.app_id,
          userIds: [subject.user_id],
        })
      ).get(subject.user_id) ?? 'none',
  };
}

/**
 * growth's routes (B1-11e): POST /v1/me/inviter runs growth's binding core on the backfill channel
 * over the same dependencies as the register channel. Without a database, Redis, the field cipher
 * or the event bus there is no core and the route answers 50001.
 */
function growthModule(): DynamicModule {
  return GrowthModule.forRoot({
    inviteBinder: {
      inject: [
        CLOCK,
        ROOT_LOGGER,
        { token: DB, optional: true },
        { token: REDIS, optional: true },
        { token: FIELD_CRYPTO, optional: true },
        { token: EVENT_BUS, optional: true },
      ],
      useFactory: (
        clock: Clock,
        logger: RootLogger,
        db?: Kysely<Database>,
        redis?: RedisHandle,
        crypto?: FieldCrypto,
        events?: EventBus,
      ): InviteBinder | null => {
        if (
          db === undefined ||
          redis === undefined ||
          crypto === undefined ||
          events === undefined
        ) {
          logger.info(
            {
              route: '/v1/me/inviter',
              db: db !== undefined,
              redis: redis !== undefined,
              field_crypto: crypto !== undefined,
              event_bus: events !== undefined,
            },
            'invite_backfill_unassembled',
          );
          return null;
        }
        return createInviteBinder(inviteBinderDeps(clock, logger, db, redis, crypto, events));
      },
    },
    // GET /v1/invites/me (B1-11j): no Redis needed; without a database, the field cipher (realname
    // birth date) or the event bus (risk's reader) there is no read and the route answers 50001.
    myInvite: {
      inject: [
        CLOCK,
        ROOT_LOGGER,
        { token: DB, optional: true },
        { token: FIELD_CRYPTO, optional: true },
        { token: EVENT_BUS, optional: true },
      ],
      useFactory: (
        clock: Clock,
        logger: RootLogger,
        db?: Kysely<Database>,
        crypto?: FieldCrypto,
        events?: EventBus,
      ): MyInviteReader | null => {
        if (db === undefined || crypto === undefined || events === undefined) {
          logger.info(
            {
              route: '/v1/invites/me',
              db: db !== undefined,
              field_crypto: crypto !== undefined,
              event_bus: events !== undefined,
            },
            'my_invite_unassembled',
          );
          return null;
        }
        return createMyInviteReader({
          clock,
          logger,
          db,
          ...growthReadPorts(clock, crypto, events),
        });
      },
    },
  });
}

/**
 * F1-09g / F1-09j: the reads behind content's page audience facts, over linking's, identity's and
 * growth's exported read ports (content imports none of them).
 */
function pageAudienceReads(
  db: Kysely<Database>,
  config: ContentReader,
  appConfig: AppConfig,
): PageAudienceReads {
  // Built on first use: entries and tests that never serve a page need no query builder here.
  let unionReads: UnionAuthReads | undefined;
  const reads = (): UnionAuthReads =>
    (unionReads ??= createUnionAuthReads({
      db: db.withSchema('app'),
      config,
      appEnv: appConfig.appEnv,
      // binding() has no PID dependency. Refuse accidental use of an auth command here.
      pids: { getActivePid: () => Promise.reject(new Error('pages: binding projection only')) },
    }));
  const activity = createInviteBackfillActivityReader(db);
  // Built on first use, like the union reads above.
  let parentReader: ParentRelationReader | undefined;
  const parents = (): ParentRelationReader =>
    (parentReader ??= createParentRelationReader({ db: db.withSchema('app') }));
  return {
    unionBindingStatus: async (appId, userId, platform) =>
      (await reads().binding(appId, userId, platform)).status,
    orderCount: (appId, userId) => activity.orderCount({ appId, userId }),
    // F1-09j: growth's current-relation reader (B1-11n). No row in this app → no parent (false);
    // a read error propagates, and content turns it into an unknown fact with a warn.
    hasParent: async (appId, userId) =>
      (await parents().relationOf({ appId, userId }))?.has_parent ?? false,
  };
}

@Module({})
class IdentityMePortsModule {}

/**
 * GET /v1/me read ports: the guard's risk service and linking's binding projection. This global
 * assembly imports risk's export so identity needs no reverse module import into risk.
 */
function identityMePorts(risk: DynamicModule): DynamicModule {
  return {
    module: IdentityMePortsModule,
    global: true,
    imports: [risk],
    providers: [
      {
        provide: ME_READ_PORTS,
        inject: [APP_CONFIG, CLOCK, riskStateServiceToken(), { token: DB, optional: true }],
        useFactory: (
          appConfig: AppConfig,
          clock: Clock,
          riskState: RiskStateService | null,
          db?: Kysely<Database>,
        ): MeReadPorts | null => {
          if (db === undefined || riskState === null) return null;
          const reads = createUnionAuthReads({
            db: db.withSchema('app'),
            config: createContentReader({ db, clock }),
            appEnv: appConfig.appEnv,
            // binding() has no PID dependency. Refuse accidental use of an auth command here.
            pids: { getActivePid: () => Promise.reject(new Error('me: binding projection only')) },
          });
          return {
            risk: riskState,
            activity: createInviteBackfillActivityReader(db),
            balance: {
              // TODO(规划/11 §2.3): 余额摘要读 ledger — blocked on ledger 模块（B2）
              balanceOf: () =>
                Promise.resolve({ available_fen: 0, withdrawable_fen: 0, estimated_total_fen: 0 }),
            },
            unionBindings: {
              async statusOf(subject, platform): Promise<MeUnionBindingStatus> {
                const { status } = await reads.binding(subject.appId, subject.userId, platform);
                switch (status) {
                  case 'unbound':
                  case 'pending_auth':
                  case 'active':
                  case 'invalid':
                  case 'released':
                  case 'blocked':
                    return status;
                  default:
                    throw new Error('me: invalid union binding status');
                }
              },
            },
          };
        },
      },
    ],
    exports: [ME_READ_PORTS],
  };
}

/** Synthetic config key of the demo quoter's rule (DemoQuoteRule); never a commission rule. */
const DEMO_QUOTE_RULE_KEY = 'demo.rebate_quote_rule';

/**
 * Per-platform quota of the governed union adapters.
 * TODO(规划/11 §4.5): 配额桶容量与 Redis 令牌桶 — blocked on CAP-TB-12、CAP-JD-12、CAP-PDD-12 配额口径
 */
const UNION_QUOTA = { capacity: 100, refillPerSecond: 10 } as const;

/**
 * Every registered union adapter wrapped once by union's governance layer (规划/02 §6.2): one
 * breaker pair and one quota bucket per platform for the whole process, so an outage seen by one
 * request opens the breaker for the next (B1-05j).
 */
function governedUnion(
  registry: UnionRegistry,
  endpoints: readonly UnionEndpoint[],
): GovernedUnion {
  const scheduler = systemScheduler();
  const adapters = new Map<RegisteredPlatform, UnionAdapter>();
  for (const platform of REGISTERED_PLATFORMS) {
    const endpoint = endpoints.find((entry) => entry.platform === platform);
    if (endpoint === undefined) continue;
    const quota = createMemoryQuotaLimiter(
      { bucketKey: endpoint.quotaKey, ...UNION_QUOTA, shares: quotaShares('mvp') },
      scheduler,
    );
    adapters.set(
      platform,
      createGovernedAdapter(registry.get(platform), { endpoint, scheduler, quota }),
    );
  }
  return {
    adapter(platform) {
      const adapter = adapters.get(platform);
      if (adapter === undefined) throw new Error(`union: no endpoint for ${platform}`);
      return adapter;
    },
  };
}

/**
 * B1-08n: the worker's order-sync ports, assembled here so orders never imports identity or
 * linking: identity's attr_code → user reader, linking's relation_id binding reader, and one
 * memory quota bucket per platform for the worker's own governed adapters (the same capacity
 * and shares as the api's governedUnion; each process keeps its own bucket and breakers).
 * B1-08q: the source backfill ports (orderSourcePorts).
 */
function orderSyncPorts(union: DynamicModule): OrdersWorkerOptions {
  return {
    union,
    users: (db) => createOrderUserReader(db),
    bindings: (db) => createOrderBindingReader(db),
    quota: (endpoint, scheduler) =>
      createMemoryQuotaLimiter(
        { bucketKey: endpoint.quotaKey, ...UNION_QUOTA, shares: quotaShares('mvp') },
        scheduler,
      ),
    sources: (db, clock, logger) => orderSourcePorts(db, clock, logger),
  };
}

/**
 * B1-10c: the claim evidence ports over the acceptance transaction — linking's raw reads, and the
 * BR-PROD-03 product key of an order whose product_key column is empty: catalog's platforms row
 * gives key_prefix, raw_item_id is the taobao item_id or the pdd goods_id (待裁定 2); other
 * platforms, a missing prefix or an underivable id give null (that item is weak at best). A read
 * error of either rejects (the acceptance rolls back, 50001).
 */
const claimEvidencePorts: ClaimEvidenceFactory = (trx, clock) => {
  const catalog = createCatalog({ db: trx, clock, warn: () => undefined });
  return {
    reads: createClaimEvidenceReader(trx),
    deriveProductKey: async ({ platform, raw_item_id }) => {
      const payload: UnionProductPayload | null =
        platform === 'taobao'
          ? { item_id: raw_item_id }
          : platform === 'pdd'
            ? { goods_id: raw_item_id }
            : null;
      if (payload === null) return null;
      const row = (await catalog.listPlatforms()).find((entry) => entry.code === platform);
      try {
        return deriveProductKey({ platform, keyPrefix: row?.key_prefix ?? null }, payload);
      } catch (error) {
        if (error instanceof ProductKeyUnderivable) return null;
        throw error;
      }
    },
  };
};
/**
 * B1-10j: orders' console claim review ports — identity's masked phones (BR-ID-33, decrypted and
 * masked inside identity; without the field cipher a phone read fails closed), admin's reviewer
 * display names and linking's link_logs time and scene. Building them reads nothing.
 */
function adminClaimPorts(db: Kysely<Database>, crypto: FieldCrypto | null): AdminClaimPorts {
  const phones = createMaskedPhoneReader(db, crypto);
  const names = createAdminDisplayNameReader(db);
  const links = createLinkLogMomentReader(db);
  return {
    phones: (appId, userIds) => phones.maskedPhones(appId, userIds),
    reviewerNames: (appId, adminIds) => names.displayNames(appId, adminIds),
    linkMoments: (appId, ids) => links.moments(appId, ids),
  };
}
/**
 * B1-08q: orders' source backfill ports (BR-ATTR-15) over linking's link_logs reader, catalog's
 * platforms (key_prefix) and content's config_items. Building them reads nothing; every call
 * reads again (a fresh content reader per call, so a changed config_items row is seen at once;
 * listPlatforms reads the table on every call). Read failures propagate unchanged.
 */
function orderSourcePorts(
  db: Kysely<Database>,
  clock: Clock,
  logger: RootLogger,
): OrderSourcePorts {
  const logs = createOrderSourceReader(db);
  const catalog = createCatalog({
    db,
    clock,
    warn: (event: CatalogWarning) => {
      logger.warn(
        { event: `catalog_${event.kind}`, product_key: event.key },
        'product_key alias chain not resolved',
      );
    },
  });
  return createOrderSourcePorts({
    linkLogs: (input) => logs.linkLogs(input),
    linkByCode: (input) => logs.linkByCode(input),
    keyPrefix: async (platform) =>
      (await catalog.listPlatforms()).find((row) => row.code === platform)?.key_prefix ?? null,
    configValue: (appId, key) => createContentReader({ db, clock }).configValue(appId, key),
  });
}

/** The strongest union mode configured: one live endpoint makes the whole process live. */
function unionModeOf(endpoints: readonly UnionEndpoint[]): UnionMode {
  if (endpoints.some((entry) => entry.mode === 'live')) return 'live';
  return endpoints.some((entry) => entry.mode === 'replay') ? 'replay' : 'demo';
}

const UNAVAILABLE_QUOTE_CONFIG: CatalogConfigReader = {
  configValue: () => Promise.reject(new Error('quoter: no database handle in this process')),
};

/** The quoter's configuration reader: one per process, shared with the open's pre-reads. */
const QUOTE_CONFIG = Symbol('QUOTE_CONFIG');

/**
 * Every key the demo quoter reads (card-assembler.ts: its rule, the tech fee and the taobao
 * compare ratio). An open pre-reads them before its transaction (B1-06m); a key missing here
 * fails that open's re-check closed instead of borrowing a second connection. The commission
 * quoter's keys are its own COMMISSION_QUOTE_CONFIG_KEYS.
 */
const DEMO_QUOTE_KEYS = [
  DEMO_QUOTE_RULE_KEY,
  'tech_fee_bp',
  'rebate.taobao.compare_rate_ratio_bp',
] as const;

/** The process quoter and the pre-reads an open makes for it (LINK_OPEN_PORTS.quoteReads). */
interface QuoterWiring {
  readonly quoter: RebateQuoter;
  readonly quoteReads: LinkOpenQuoteReads;
}

const QUOTER_WIRING = Symbol('QUOTER_WIRING');

/**
 * B2-03d: the commission rule versions as an open sees them. Outside an open every call reads
 * straight through (the quoter selects at its own quote instant). Inside an open the read is
 * memoized per app by the open's scope, and cut at the open's own pre-read instant (the Clock
 * read before the port, each open anew): a version that only becomes effective after that
 * instant is invisible for the whole open, so a future version revoked after the pre-read can
 * never be quoted from (BR-CALC-11, BR-CALC-20); the quoter then selects the latest version in
 * force from what is left.
 */
function openScopedRules(rules: RuleSetReader, clock: Clock): RuleSetReader {
  return {
    publishedVersions: (appId) =>
      openScopedReader(rules, JSON.stringify([appId]), 'commission rule versions', async () => {
        if (!inOpenReads()) return rules.publishedVersions(appId);
        const at = clock.now().getTime();
        const versions = await rules.publishedVersions(appId);
        return versions.filter((version) => version.effective_from.getTime() <= at);
      }),
  };
}

/** B2-03d: user levels, memoized per (app, user) inside an open; read through elsewhere. */
function openScopedLevels(levels: UserLevelReader): UserLevelReader {
  return {
    levelOf: (subject) =>
      openScopedReader(levels, JSON.stringify([subject.appId, subject.userId]), 'user level', () =>
        levels.levelOf({ appId: subject.appId, userId: subject.userId }),
      ),
  };
}

/** The non-guest viewers an open may quote for: the caller and every owner identity. */
function planUsers(plan: LinkOpenReadPlan): string[] {
  const users = new Set<string>();
  if (plan.callerUserId !== null) users.add(plan.callerUserId);
  for (const identity of plan.identities) {
    if (identity.userId !== null) users.add(identity.userId);
  }
  return [...users];
}

/**
 * B2-03d (BR-CALC-20): the process RebateQuoter. APP_ENV=prod or any live union endpoint takes
 * commission's real quoter over the rule versions, user levels and quote configuration, each
 * wrapped in the open's read scope; it needs the database handle and refuses to start without
 * one (never the demo quoter instead). Every other environment keeps the demo quoter.
 * The real quoter is stateless (live only, B2-03n), so concurrent opens and search cards never
 * answer for each other. An open's pre-reads go through the wrapped ports (the
 * AsyncLocalStorage scope of link-open-reads.ts), so inside an open's transaction the quoter
 * answers only from them and outside an open it reads straight through. Pre-read failures are settled and surface where
 * the transaction reads them (B1-06m).
 */
function assembleQuoter(
  config: AppConfig,
  endpoints: readonly UnionEndpoint[],
  quoteConfig: CatalogConfigReader,
  clock: Clock,
  db?: Kysely<Database>,
): QuoterWiring {
  if (config.appEnv !== 'prod' && unionModeOf(endpoints) !== 'live') {
    return {
      quoter: createDemoRebateQuoter({
        appEnv: config.appEnv,
        unionMode: unionModeOf(endpoints),
        config: quoteConfig,
        ruleConfigKey: DEMO_QUOTE_RULE_KEY,
      }),
      quoteReads: {
        prepare: async (plan) => {
          await Promise.allSettled(
            DEMO_QUOTE_KEYS.map((key) => quoteConfig.configValue(plan.appId, key)),
          );
        },
      },
    };
  }
  if (db === undefined) {
    throw new Error(
      'quoter: the commission rebate quoter (prod or a live union endpoint) needs a database handle',
    );
  }
  const rules = openScopedRules(createRuleSetReader({ db }), clock);
  const levels = openScopedLevels(createUserLevelReader({ db }));
  const quoter = createCommissionRebateQuoter({ rules, levels, config: quoteConfig, clock });
  return {
    quoter,
    quoteReads: {
      prepare: async (plan) => {
        const { appId } = plan;
        await Promise.allSettled([
          rules.publishedVersions(appId),
          ...planUsers(plan).map((userId) => levels.levelOf({ appId, userId })),
          ...COMMISSION_QUOTE_CONFIG_KEYS.map((key) => quoteConfig.configValue(appId, key)),
        ]);
      },
    },
  };
}

/**
 * Jump paths verified per platform and client for prod (B1-06e fund review S2): none yet, so a
 * prod open hands out no jump and answers 50301; non-prod hands out the default matrix.
 * TODO(规划/11 §4.5): 按实测登记已验证的外跳路径 — blocked on CAP-JD-11、CAP-PDD-11
 */
const VERIFIED_JUMP_PATHS: LinkOpenPorts['verifiedPaths'] = {};

/** parseUrl resolves and derives only; it never assembles a card (B1-07a), so none is given. */
const NO_PARSE_CARDS: CatalogCardEntry = {
  assemble: () => Promise.reject(new Error('linking: the by-URL port assembles no card')),
};

/**
 * B1-06i: the convert's ports — catalog over the database handle, the item_ref service of the
 * open, and parsing's by-URL port (parseUrl over content's configuration reader and the same
 * governed adapters), so linking imports neither catalog's providers nor parsing.
 */
function convertPorts(
  db: Kysely<Database>,
  clock: Clock,
  logger: RootLogger,
  union: GovernedUnion,
  itemRefs: LinkConvertPorts['itemRefs'],
): LinkConvertPorts {
  const products = createCatalog({
    db,
    clock,
    warn: (event: CatalogWarning) => {
      logger.warn(
        { event: `catalog_${event.kind}`, product_key: event.key },
        'product_key alias chain not resolved',
      );
    },
  });
  const config = createContentReader({ db, clock });
  return {
    products,
    itemRefs,
    urlParser: {
      parseUrl: (url, context) =>
        parseUrl(
          {
            config,
            catalog: products,
            cards: NO_PARSE_CARDS,
            clock,
            getGovernedAdapter: (platform) => union.adapter(platform),
            logger,
          },
          url,
          context,
        ),
    },
  };
}

@Module({})
class CatalogPortsModule {}

/**
 * Global providers of catalog's search ports, assembled here so catalog and linking never import
 * each other (no forwardRef):
 * - GovernedUnion: union adapters wrapped once per process (also for later parsing wiring);
 * - LinkRegistrar: linking's card registration in the search scene (BR-PRICE-12), per request;
 * - RebateQuoter: commission's real quoter under APP_ENV=prod or any live union endpoint (it
 *   needs the database handle), the demo quoter (synthetic rule values) elsewhere; one process
 *   quoter shared by search, detail, parse cards and the open (assembleQuoter, B2-03d);
 * - LINK_OPEN_PORTS: linking's open (B1-06w) — the same governed adapters and quoter, an
 *   item_ref issuer, contracts/apps.json and the prod-verified jump paths; and the convert's
 *   catalog, item_ref verifier and parsing's by-URL port (B1-06i);
 * - LINK_LANDING_PORTS: linking's landing card (B1-06j) — catalog's read-only product port
 *   (product_refs, else one detail on the same governed adapters; never a write or conversion);
 * - the linking module itself is re-exported, so its SourceLinkReader is visible to catalog.
 */
function catalogPorts(union: DynamicModule, linking: DynamicModule): DynamicModule {
  return {
    module: CatalogPortsModule,
    global: true,
    imports: [union, linking],
    providers: [
      {
        provide: GovernedUnion,
        inject: [UNION_REGISTRY, UNION_ENDPOINTS],
        useFactory: governedUnion,
      },
      {
        provide: LinkRegistrar,
        inject: [LINK_REGISTRATIONS],
        useFactory: (registrations: LinkRegistrations): LinkRegistrar => {
          const registration = registrations.forContext({ scene: 'search' });
          return { register: (input: RegisterLinkInput) => registration.register(input) };
        },
      },
      {
        // Inside an open it answers only from the open's pre-reads; elsewhere it reads through.
        provide: QUOTE_CONFIG,
        inject: [CLOCK, { token: DB, optional: true }],
        useFactory: (clock: Clock, db?: Kysely<Database>): CatalogConfigReader =>
          db === undefined
            ? UNAVAILABLE_QUOTE_CONFIG
            : openScopedConfig(createContentReader({ db, clock })),
      },
      {
        provide: QUOTER_WIRING,
        inject: [APP_CONFIG, UNION_ENDPOINTS, QUOTE_CONFIG, CLOCK, { token: DB, optional: true }],
        useFactory: assembleQuoter,
      },
      {
        provide: RebateQuoter,
        inject: [QUOTER_WIRING],
        useFactory: (wiring: QuoterWiring): RebateQuoter => wiring.quoter,
      },
      {
        provide: LINK_OPEN_PORTS,
        inject: [
          GovernedUnion,
          QUOTER_WIRING,
          APP_CONFIG,
          CLOCK,
          ROOT_LOGGER,
          { token: FIELD_CRYPTO, optional: true },
          { token: DB, optional: true },
        ],
        useFactory: (
          union: GovernedUnion,
          wiring: QuoterWiring,
          config: AppConfig,
          clock: Clock,
          logger: RootLogger,
          crypto?: FieldCrypto,
          db?: Kysely<Database>,
        ): LinkOpenPorts => {
          if (crypto === undefined && config.appEnv !== 'local' && config.appEnv !== 'test') {
            throw new Error('linking: item_ref needs the field keyring outside local / test');
          }
          // The re-checked card's item_ref is never sent by an open; it is issued as for any card.
          // The convert verifies the tapped card's token with the same keyring (BR-PROD-11).
          const itemRefs = createItemRefService({ crypto: crypto ?? processItemRefCipher() });
          return {
            union,
            quoter: wiring.quoter,
            itemRefs,
            quoteReads: wiring.quoteReads,
            apps: loadLinkOpenApps(),
            verifiedPaths: VERIFIED_JUMP_PATHS,
            ...(db === undefined
              ? {}
              : { convert: convertPorts(db, clock, logger, union, itemRefs) }),
          };
        },
      },
      {
        provide: LINK_LANDING_PORTS,
        inject: [
          GovernedUnion,
          CLOCK,
          { token: DB, optional: true },
          { token: REDIS, optional: true },
        ],
        useFactory: (
          union: GovernedUnion,
          clock: Clock,
          db?: Kysely<Database>,
          redis?: RedisHandle,
        ): LinkLandingPorts =>
          db === undefined
            ? {
                // No database handle: no product_refs and no jd mode, so no product fields.
                products: {
                  read: () =>
                    Promise.resolve({ title: null, image: null, shopName: null, shopType: null }),
                },
              }
            : {
                // B1-05g: the union fallback reads through the shared detail cache.
                products: createDbCatalogProductReader({
                  db,
                  union,
                  config: createContentReader({ db, clock }),
                  clock,
                  cache: redis === undefined ? null : redis.namespace(PRODUCT_CACHE_NAMESPACE),
                }),
              },
      },
    ],
    exports: [
      GovernedUnion,
      LinkRegistrar,
      RebateQuoter,
      LINK_OPEN_PORTS,
      LINK_LANDING_PORTS,
      linking,
    ],
  };
}

/**
 * Parsing's card-time link registration (POST /v1/inputs/parse, B1-07b): linking's per-request
 * registration in the request's entry scene (clipboard / search / share_ext), assembled here so
 * parsing never imports linking. Global beside catalogPorts, whose linking export it uses.
 */
@Module({})
class ParsingPortsModule {}

function parsingPorts(): DynamicModule {
  return {
    module: ParsingPortsModule,
    global: true,
    providers: [
      {
        provide: ParsingLinkRegistrars,
        inject: [LINK_REGISTRATIONS],
        useFactory: (registrations: LinkRegistrations): ParsingLinkRegistrars => ({
          forScene(scene: ParseScene): LinkRegistrar {
            const registration = registrations.forContext({ scene });
            return { register: (input: RegisterLinkInput) => registration.register(input) };
          },
        }),
      },
    ],
    exports: [ParsingLinkRegistrars],
  };
}

/**
 * The risk module of the `api` entry: stage ① (device signing keys from identity) and stage ④a,
 * whose minimum supported version port is content's reader of app_versions (same assembly as
 * identityModule(); risk never imports content, B1-03c): cached on the pool for the guard, and
 * built over the idempotency claim's transaction for the post-miss hook. No database handle: no reader, and a
 * request that needs the minimum answers 50001.
 * Stage ⑬ (rate limits, B1-03e): its thresholds port reads `rate_limit.ops` and
 * `rate_limit.<group>` through content's cached configValue; no database handle: the code
 * defaults only. Its buckets use REDIS (none: stage ⑬ is not installed).
 * Same-device multi-account check (BR-ID-37, B1-03k): sameDeviceAccountsCheckToken(), over
 * identity's login reader and content's configuration reader bound to the caller's handle.
 * Appeals (POST / GET /v1/me/appeals, B1-03i): the deadline calendar through content's reader
 * bound to the submission's transaction.
 * The guard's pooled minimum-version reader is the same instance as the one behind GET
 * /v1/app-versions/check (F1-02e followup), so both answer from one cache.
 */
function riskModule(identity: DynamicModule, contentReader: SharedContentReader): DynamicModule {
  return RiskModule.forRoot({
    imports: [identity],
    // ⑥ deletion cooling / processing (B1-15e), ⑦ privacy consent (B1-02zh), then ⑧ ⑨ identity
    // level (B1-02za), before ⑫ step-up (B1-02y) on the idempotent path; the deletion, privacy and
    // level guards, in that order, between ⑤ and ⑬ on the non-idempotent path. The list order is
    // the decision order.
    beforeRateLimit: {
      inject: [DELETION_STAGE_CHECKS, PRIVACY_CONSENT_CHECKS, IDENTITY_LEVEL_CHECKS, STEP_UP_CHECK],
      useFactory: (
        deletion: DeletionStageChecks,
        privacy: PrivacyConsentChecks,
        level: IdentityLevelChecks,
        stepUp: IdempotencyPostMissCheck,
      ) => [deletion.postMiss, privacy.postMiss, level.postMiss, stepUp],
    },
    beforeRateLimitGuards: {
      inject: [DELETION_STAGE_CHECKS, PRIVACY_CONSENT_CHECKS, IDENTITY_LEVEL_CHECKS],
      useFactory: (
        deletion: DeletionStageChecks,
        privacy: PrivacyConsentChecks,
        level: IdentityLevelChecks,
      ) => [deletion.guard, privacy.guard, level.guard],
    },
    minimumVersions: {
      inject: [CLOCK, { token: DB, optional: true }],
      // pooled: the guard's cached reader; on: a fresh reader over the idempotency claim's
      // transaction for the post-miss hook (no second pooled connection while holding one).
      useFactory: (clock: Clock, db?: Kysely<Database>): MinimumVersionReaders | null =>
        db === undefined
          ? null
          : {
              pooled: contentReader(db, clock),
              on: (handle) => createContentReader({ db: handle, clock }),
            },
    },
    rateLimit: {
      thresholds: {
        inject: [CLOCK, { token: DB, optional: true }],
        // pooled: the guard's cached reader; on: a fresh reader over the idempotency claim's
        // transaction for the post-miss hook (no second pooled connection while holding one).
        useFactory: (clock: Clock, db?: Kysely<Database>): RateLimitThresholdReaders | null =>
          db === undefined
            ? null
            : {
                pooled: createRateLimitThresholdReader(createContentReader({ db, clock })),
                on: (handle) =>
                  createRateLimitThresholdReader(createContentReader({ db: handle, clock })),
              },
      },
    },
    // BR-ID-37 (B1-03k): identity's login reader; configuration through content's reader over
    // the caller's handle, so the check reads and writes on the caller's transaction only.
    sameDevice: {
      logins: createSameDeviceLoginReader(),
      config: {
        inject: [CLOCK],
        useFactory: (clock: Clock) => (handle: Kysely<Database>) =>
          createContentReader({ db: handle, clock }),
      },
    },
    // Appeals (BR-ID-36, B1-03i): the deadline's working-day calendar (calendar.cn_holidays.<year>,
    // calendar.cn_makeup_workdays.<year>) through content's reader over the submission's handle.
    appeals: {
      config: {
        inject: [CLOCK],
        useFactory: (clock: Clock) => (handle: Kysely<Database>) =>
          createContentReader({ db: handle, clock }),
      },
    },
  });
}

/**
 * The admin entry's console module (F1-06k, F1-06l). The sms step-up tier sends through identity's
 * SmsSender port, provided here under identity's sender token as identity provides it on the api
 * entry (the fake adapter in local / test, whose outbox tests read), so admin never imports
 * identity.
 */
function adminAuthModule(): DynamicModule {
  return AdminAuthModule.forRoot({
    // B1-34a: the audit search derives a configuration record's permission point from it.
    configPermissions: new Map(configRegistry().map((item) => [item.key, item.permission])),
    smsSender: {
      provide: smsSenderToken(),
      inject: [APP_CONFIG, ROOT_LOGGER],
      useFactory: (config: AppConfig, logger: RootLogger) => createSmsSender(config.appEnv, logger),
    },
  });
}

/**
 * Root module, assembled per process entry. Every HTTP entry serves the health probe; the `api`
 * entry also serves the /v1 identity routes, the risk module's request signature check, whose
 * device port identity implements, identity's token check, and the risk module's stage ④a gate
 * (minimum supported version and restricted session, 10405; B1-03c). The stream entry shares
 * identity's checks and risk's guards without their public routes or the signature check.
 * The union module (adapter registry
 * and endpoint configuration) loads where union platforms are called: `api` (search, linking) and `worker` (order sync); the
 * other worker entries load only the platform and admin modules.
 * The admin module provides the platform audit port on every entry (F1-06b).
 * The catalog module (platform dictionary, product_refs, aliases, category blocklist) loads on
 * `api`, where search, detail and parsing run; its configuration port is content's reader,
 * assembled here so catalog never imports content (B1-05c).
 * The linking module (card-time link registration, B1-06c) loads on `api` beside catalog; its
 * configuration port is content's reader too, assembled here so linking never imports content.
 * The parsing module (parse_input core, B1-07a) loads on `api` as well; its configuration port
 * (parse.tpwd.enabled, product_key.jd.mode) is content's reader, so parsing never imports content.
 * On `api`, catalogPorts makes the governed union adapters, linking's registrar and the demo
 * quoter global, for catalog's GET /v1/products/search (B1-05j) and parsing's POST
 * /v1/inputs/parse (B1-07b), which registers its links through parsingPorts in the request's scene.
 * Business modules are added to the entries that own them by their tasks (规划/02 §4.1).
 */
/**
 * B1-02m: identity's request identity for catalog's ViewerContext and linking's CallerContext
 * (the token principal, else the verified device's guest, else the X-App-Id guest), resolved per
 * request, and its users.attr_code reader for linking's AttrCodeReader (unavailable without a
 * database handle, as linking's default). identity implements the ports structurally.
 */
/**
 * F1-02e followup: one cached content reader per assembled app, handed to both risk's
 * minimum-version gate (pooled) and ContentPublicModule (GET /v1/app-versions/check, GET
 * /v1/config), so an admin change to a minimum version reaches both at the same refresh.
 */
type SharedContentReader = (db: Kysely<Database>, clock: Clock) => ContentReader;
function sharedContentReader(): SharedContentReader {
  let shared:
    | { readonly db: Kysely<Database>; readonly clock: Clock; readonly reader: ContentReader }
    | undefined;
  return (db, clock) => {
    if (shared === undefined || shared.db !== db || shared.clock !== clock) {
      shared = { db, clock, reader: createContentReader({ db, clock }) };
    }
    return shared.reader;
  };
}

const identityViewer = {
  scope: Scope.REQUEST,
  inject: [REQUEST],
  useFactory: (request: IdentityRequest): IdentityContext => createIdentityViewerContext(request),
};
const identityCaller = {
  scope: Scope.REQUEST,
  inject: [REQUEST],
  useFactory: (request: IdentityRequest): IdentityContext => createIdentityCallerContext(request),
};
const identityAttrCodes = {
  inject: [{ token: DB, optional: true }],
  useFactory: (db?: Kysely<Database>): IdentityAttrCodeReader =>
    db === undefined ? createUnavailableAttrCodeReader() : createIdentityAttrCodeReader(db),
};

/** identity's push token port onto notification's commands (B1-12b), for every entry that ends sessions. */
function sessionPushTokens(clock: Clock): SessionPushTokens {
  return {
    bind: (trx, session) => bindPushTokensForSession(trx, session, clock),
    unbind: (trx, session) => unbindPushTokensForSession(trx, session, clock),
  };
}

@Module({})
export class AppModule {
  static forEntry(options: PlatformOptions): DynamicModule {
    const contentReader = sharedContentReader();
    // One module object for both imports, so Nest builds the identity module once.
    const identity =
      options.entry === 'api'
        ? identityModule(contentReader)
        : options.entry === 'stream'
          ? streamIdentityModule()
          : undefined;
    const risk =
      identity === undefined
        ? undefined
        : options.entry === 'stream'
          ? streamRiskModule(identity, contentReader)
          : riskModule(identity, contentReader);
    // Stage ⑦ (B1-02zh) is not assembled on stream: it judges only x-auth login / phone / realname
    // routes, and every /v1/agent/ route is optional.
    // Stage ⑥ (B1-15m) is assembled on stream alone, in streamRiskModule's two lists.
    // One module object per import: Nest builds union and linking once.
    const union =
      options.entry === 'api' || options.entry === 'worker' ? UnionModule.forRoot() : undefined;
    const linking =
      options.entry === 'api'
        ? LinkingModule.forRoot((db, clock) => createContentReader({ db, clock }), {
            callerContext: identityCaller,
            attrCodeReader: identityAttrCodes,
          })
        : undefined;
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(options),
        // Provides the platform AUDIT_PORT globally on every entry (F1-06b).
        AdminModule,
        ...(isHttpEntry(options.entry) ? [HealthModule] : []),
        // The /admin/v1 login routes, the admin request check and CORS policy (F1-06k); step-up
        // and me/permissions (F1-06l), whose sms tier sends through identity's SMS sender.
        ...(options.entry === 'admin' ? [adminAuthModule()] : []),
        // content's /admin/v1 routes (platform marks, F1-06w / F1-06y), guarded through
        // platform's AdminOperationGuard, which adminAuthModule provides on this entry only. Its
        // writes append audit rows through admin's writer bound to their own transaction.
        ...(options.entry === 'admin'
          ? [
              ContentAdminModule.forAdmin({
                auditWriter: (db, clock) =>
                  createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
              }),
            ]
          : []),
        // identity's /admin/v1 user reveal (F1-07a, BR-ID-33): guarded by AdminOperationGuard,
        // audited through the global AUDIT_PORT before the value is returned.
        ...(options.entry === 'admin' ? [IdentityAdminModule.forAdmin()] : []),
        // linking's /admin/v1 union authorization management (F1-07c, BR-ID-20): guarded by
        // AdminOperationGuard; each change and its audit row (admin's writer bound to the change's
        // transaction) commit together; the reset's cooldown reads content's configuration.
        ...(options.entry === 'admin'
          ? [
              LinkingAdminModule.forAdmin({
                auditWriter: (db, clock) =>
                  createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
                configReader: (db, clock) => createContentReader({ db, clock }),
              }),
            ]
          : []),
        // risk's /admin/v1 ban / unban / freeze / unfreeze (F1-07d, BR-ID-31): guarded by
        // AdminOperationGuard; the state change, identity's revocation of every session of the
        // user (with the push token unbinding, as on the api entry), linking's binding ports and
        // the audit row (admin's writer bound to the change's transaction) commit together. Its
        // risk state writer stamps REDIS so the api entry's cached states end at once.
        ...(options.entry === 'admin'
          ? [
              RiskAdminModule.forAdmin({
                auditWriter: (db, clock) =>
                  createAuditWriter({ db, clock, sensitiveKeys: SENSITIVE_KEYS }),
                revokeSessions: (clock) => (trx, input) =>
                  revokeSessionsByUser(trx, input, clock, unbindRevoked(sessionPushTokens(clock))),
                blockForBan,
                restoreAfterUnban,
              }),
            ]
          : []),
        // orders' /admin/v1 claim review reads (B1-10j; BR-ATTR-30): guarded by AdminOperationGuard;
        // the applicant's masked phone through identity's port (decrypted and masked there), the
        // reviewer's display name through admin's, the evidence records' time and scene through
        // linking's. Reads only, no audit row.
        ...(options.entry === 'admin'
          ? [OrdersAdminModule.forAdmin({ ports: adminClaimPorts })]
          : []),
        // content's GET /v1/config (F1-02c): agent availability and the h5_release bucket read
        // identity's request viewer (token principal, else the X-App-Id guest). GET
        // /v1/pages/{page_key} (F1-09d) reads the same viewer for its login condition.
        ...(options.entry === 'api'
          ? [
              ContentPublicModule.forApi({
                viewerContext: identityViewer,
                contentReader: {
                  inject: [CLOCK, { token: DB, optional: true }],
                  useFactory: (clock: Clock, db?: Kysely<Database>): ContentReader | null =>
                    db === undefined ? null : contentReader(db, clock),
                },
                // F1-09g: page audience facts over linking's binding projection and identity's
                // order count (both scoped by app_id and user_id).
                audienceReads: {
                  inject: [APP_CONFIG, CLOCK, { token: DB, optional: true }],
                  useFactory: (
                    appConfig: AppConfig,
                    clock: Clock,
                    db?: Kysely<Database>,
                  ): PageAudienceReads | null =>
                    db === undefined
                      ? null
                      : pageAudienceReads(db, contentReader(db, clock), appConfig),
                },
                // F1-02zp / B1-35: GET /v1/config's invite.reward_enabled reads growth's available
                // total budget (total − reserved − granted), config_items on its own read transaction.
                inviteRewardBudget: {
                  inject: [CLOCK, { token: DB, optional: true }],
                  useFactory: (clock: Clock, db?: Kysely<Database>) =>
                    db === undefined
                      ? null
                      : createInviteRewardBudgetReader({ db, config: transactionConfig(clock) }),
                },
              }),
              NotificationModule.forApi((db, clock) => createContentReader({ db, clock })),
              // GET /v1/orders and /v1/orders/{order_id} over the shared OrderQueries (B1-08l):
              // content's configuration reader and linking's order-link reader as its ports.
              // GET /v1/orders/pending-tracks and its dismiss (B1-08m) over linking's open
              // attempts port. POST /v1/orders/claims settles claim evidence (B1-10c) over
              // linking's raw reads and catalog's platforms on its acceptance transaction.
              // GET /v1/orders?scope=self's claim_entry_pinned (B1-10h, BR-ATTR-17) over linking's
              // claim-entry reader (link_logs jump-outs, union_bindings).
              OrdersModule.forRoot({
                config: (db, clock) => createContentReader({ db, clock }),
                links: (db) => createOrderLinkReader(db),
                claimEntry: (db) => createClaimEntryReader(db),
                attempts: (db) => createPendingAttemptStore(db),
                evidence: claimEvidencePorts,
              }),
            ]
          : []),
        ...(identity === undefined || risk === undefined ? [] : [identity, risk]),
        ...(options.entry === 'api' && risk !== undefined ? [identityMePorts(risk)] : []),
        // growth's POST /v1/me/inviter (B1-11e): on the api entry, beside identity and risk, whose
        // global guard and idempotency post-miss hooks run stages ①–⑧ before it.
        ...(options.entry === 'api' ? [growthModule()] : []),
        ...(union === undefined ? [] : [union]),
        // The ledger posting port (B2-02f) on every entry that books money: settlement (worker),
        // withdrawals (api, payout) and adjustments (admin); the stream entry books nothing.
        ...(options.entry === 'stream' ? [] : [LedgerModule.forRoot()]),
        // Freeze expiry and the daily risk alerts (BR-ID-36, B1-03j): the risk-scan queue's
        // handler, worked by the worker entry only; entry.ts seeds the chain after the queue starts.
        ...(options.entry === 'worker'
          ? [
              RiskScanModule.forWorker(),
              AgentModule.forWorker(),
              // risk.state_changed → RISK_STATE_CHANGED inbox message (B1-12g, BR-TEXT-23).
              // Its unbanned {need_reauth} reads linking's Taobao binding port (SELECT only).
              NotificationModule.forWorker({ taobaoReauthReader: needsTaobaoReauth }),
              // Admin data exports (B1-34e, BR-ID-42): the export queue's generate / expire
              // handler over identity's batch users projection (decrypted and masked there) and
              // content's configuration reader (admin.export.* overrides of the code defaults).
              // Nothing is seeded: jobs come from the creating and the done transactions.
              ExportWorkerModule.forWorker({
                users: (db, crypto) => createExportUsersReader({ db, crypto }),
                config: (db, clock) => createContentReader({ db, clock }),
                configPermissions: new Map(
                  configRegistry().map((item) => [item.key, item.permission]),
                ),
              }),
            ]
          : []),
        // The scheduled takeover / recheck of the paid bank-card verification records (B1-13g,
        // BR-WDR-02 ⑦): worker entry only, without the HTTP IdentityModule; entry.ts starts the
        // timer after the risk-scan heal and stops it first on shutdown.
        ...(options.entry === 'worker'
          ? [IdentityWorkerModule.forWorker({ payoutAccountConfig })]
          : []),
        // The cooling-period expiry of deletion requests (B1-15f, BR-ID-27): worker entry only;
        // entry.ts starts its 60-second timer after the payout verification recheck.
        ...(options.entry === 'worker'
          ? [
              IdentityDeletionExpiryModule.forWorker({
                calendarConfig: deletionCalendarConfig,
                withdrawals: deletionWithdrawals,
                balance: deletionBalance,
              }),
            ]
          : []),
        // growth's invite reward scanner (B1-35, BR-INV-24): worker entry only; entry.ts starts its
        // 60-second loop after the queue runs and stops it first on shutdown.
        ...(options.entry === 'worker' ? [inviteRewardWorkerModule()] : []),
        // Order sync (B1-08n): the order-sync handler and its scheduler, worked by the worker
        // entry only over its own governed union adapters; entry.ts starts the scheduler after
        // the queue runs.
        ...(options.entry === 'worker' && union !== undefined
          ? [OrdersModule.forWorker(orderSyncPorts(union))]
          : []),
        ...(options.entry === 'stream'
          ? [
              AgentModule.forStream({
                consentReader: createAiConsentReader,
                callerReader: createAgentCallerReader,
              }),
            ]
          : []),
        ...(options.entry === 'api' && union !== undefined && linking !== undefined
          ? [
              catalogPorts(union, linking),
              CatalogModule.forRoot((db, clock) => createContentReader({ db, clock }), {
                viewerContext: identityViewer,
              }),
              linking,
              parsingPorts(),
              // createParsing from parsing's public surface, so the route builds its service
              // through index.ts like any other caller.
              ParsingModule.forRoot((db, clock) => createContentReader({ db, clock }), {
                createParsing,
                localItemRefCipher: processItemRefCipher,
              }),
            ]
          : []),
      ],
      providers: isHttpEntry(options.entry) ? [requestChecks(options)] : [],
    };
  }
}
