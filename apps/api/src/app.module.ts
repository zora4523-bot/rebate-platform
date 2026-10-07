import { type DynamicModule, type Provider, Module } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import { AdminModule } from './modules/admin/index.ts';
import {
  CatalogModule,
  GovernedUnion,
  LinkRegistrar,
  RebateQuoter,
  createDemoRebateQuoter,
  createItemRefService,
  type CatalogConfigReader,
  type RegisterLinkInput,
} from './modules/catalog/index.ts';
import { createContentReader } from './modules/content/index.ts';
import { HealthModule } from './modules/health/index.ts';
import {
  IdentityModule,
  TOKEN_CHECK,
  type IdentityConfigReader,
} from './modules/identity/index.ts';
import {
  LINK_OPEN_PORTS,
  LINK_REGISTRATIONS,
  LinkingModule,
  loadLinkOpenApps,
  openScopedConfig,
  type LinkOpenPorts,
  type LinkRegistrations,
} from './modules/linking/index.ts';
// The composition root may reach catalog's wiring helper: the process item_ref cipher of local /
// test without a field keyring, shared with parsing's card entry (not a module-to-module import).
import { createProcessItemRefCipher } from './modules/catalog/infra/search-wiring.ts';
import {
  ParsingLinkRegistrars,
  ParsingModule,
  createParsing,
  type ParseScene,
} from './modules/parsing/index.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  FIELD_CRYPTO,
  PlatformModule,
  ROOT_LOGGER,
  createMemoryQuotaLimiter,
  quotaShares,
  systemScheduler,
  type AppConfig,
  type Clock,
  type FieldCrypto,
  type PlatformOptions,
  type RootLogger,
  REQUEST_CHECKS,
  type RequestCheck,
  type RequestCheckPlan,
  isContractSignedRoute,
  isHttpEntry,
} from './modules/platform/index.ts';
import {
  RiskModule,
  SIGNATURE_CHECK,
  createBlocklistService,
  type BlocklistService,
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
 * (bootstrap refuses a plan where it is not), then identity's token stages ② ③. Both run on every
 * matched route; only the contract x-signed routes have their body buffered before the checks
 * (the signature covers it), so ② ③ answer an unsigned route from its headers alone, before its
 * body is read or validated, and its body keeps Fastify's own handling. ① skips unsigned routes;
 * ② ③ act by the route's contract x-auth and leave routes outside the contract alone.
 * The factory stays synchronous (its async dependencies are providers of their own).
 * The other HTTP entries have no check yet, so bootstrap refuses on them an x-signed route and a
 * route that takes a token (contract x-auth other than none).
 */
function requestChecks(options: PlatformOptions): Provider {
  return options.entry === 'api'
    ? {
        provide: REQUEST_CHECKS,
        inject: [SIGNATURE_CHECK, TOKEN_CHECK],
        useFactory: (signature: RequestCheck, token: RequestCheck): RequestCheckPlan => ({
          checks: [signature, token],
          bufferWhen: isContractSignedRoute,
        }),
      }
    : { provide: REQUEST_CHECKS, useValue: { checks: [] } satisfies RequestCheckPlan };
}

/**
 * The identity module of the `api` entry. Its configuration port (sms.blocked_prefixes, BR-ID-05;
 * the minimum supported version of the session scope, BR-ID-01 细则「受限会话」) is content's cached
 * reader of config_items and app_versions: content implements the port's shape without importing
 * identity (same assembly as the risk ports, F1-02b). No database handle (isolated HTTP unit
 * tests): no reader, and the SMS code route answers 50001.
 * Its blocklist port is risk's blocklist service (B1-03d: SMS send, SMS login before creating an
 * account, the same-device limit), built here so identity and risk stay plain ports to each
 * other; without a database or field cipher there is none.
 */
function identityModule(): DynamicModule {
  return IdentityModule.forRoot({
    config: {
      inject: [CLOCK, { token: DB, optional: true }],
      useFactory: (clock: Clock, db?: Kysely<Database>): IdentityConfigReader | null =>
        db === undefined ? null : createContentReader({ db, clock }),
    },
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
  });
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
 * fails that open's re-check closed instead of borrowing a second connection.
 * TODO(规划/11 §4.5): 真实报价器自带预读清单 — blocked on B2-03（佣金规则与用户等级）
 */
const DEMO_QUOTE_KEYS = [
  DEMO_QUOTE_RULE_KEY,
  'tech_fee_bp',
  'rebate.taobao.compare_rate_ratio_bp',
] as const;

/**
 * Jump paths verified per platform and client for prod (B1-06e fund review S2): none yet, so a
 * prod open hands out no jump and answers 50301; non-prod hands out the default matrix.
 * TODO(规划/11 §4.5): 按实测登记已验证的外跳路径 — blocked on CAP-JD-11、CAP-PDD-11
 */
const VERIFIED_JUMP_PATHS: LinkOpenPorts['verifiedPaths'] = {};

@Module({})
class CatalogPortsModule {}

/**
 * Global providers of catalog's search ports, assembled here so catalog and linking never import
 * each other (no forwardRef):
 * - GovernedUnion: union adapters wrapped once per process (also for later parsing wiring);
 * - LinkRegistrar: linking's card registration in the search scene (BR-PRICE-12), per request;
 * - RebateQuoter: the demo quoter (BR-CALC-20 with synthetic rule values). It refuses prod and
 *   live union endpoints, so such an entry does not start;
 *   TODO(规划/11 §4.5): 真实报价器 — blocked on B2-03（佣金规则与用户等级）
 * - LINK_OPEN_PORTS: linking's open (B1-06w) — the same governed adapters and quoter, an
 *   item_ref issuer, contracts/apps.json and the prod-verified jump paths;
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
        provide: RebateQuoter,
        inject: [APP_CONFIG, UNION_ENDPOINTS, QUOTE_CONFIG],
        useFactory: (
          config: AppConfig,
          endpoints: readonly UnionEndpoint[],
          quoteConfig: CatalogConfigReader,
        ): RebateQuoter =>
          createDemoRebateQuoter({
            appEnv: config.appEnv,
            unionMode: unionModeOf(endpoints),
            config: quoteConfig,
            ruleConfigKey: DEMO_QUOTE_RULE_KEY,
          }),
      },
      {
        provide: LINK_OPEN_PORTS,
        inject: [
          GovernedUnion,
          RebateQuoter,
          QUOTE_CONFIG,
          APP_CONFIG,
          { token: FIELD_CRYPTO, optional: true },
        ],
        useFactory: (
          union: GovernedUnion,
          quoter: RebateQuoter,
          quoteConfig: CatalogConfigReader,
          config: AppConfig,
          crypto?: FieldCrypto,
        ): LinkOpenPorts => {
          if (crypto === undefined && config.appEnv !== 'local' && config.appEnv !== 'test') {
            throw new Error('linking: item_ref needs the field keyring outside local / test');
          }
          return {
            union,
            quoter,
            // The re-checked card's item_ref is never sent by an open; it is issued as for any card.
            itemRefs: createItemRefService({ crypto: crypto ?? createProcessItemRefCipher() }),
            quoteReads: {
              prepare: async (appId) => {
                await Promise.allSettled(
                  DEMO_QUOTE_KEYS.map((key) => quoteConfig.configValue(appId, key)),
                );
              },
            },
            apps: loadLinkOpenApps(),
            verifiedPaths: VERIFIED_JUMP_PATHS,
          };
        },
      },
    ],
    exports: [GovernedUnion, LinkRegistrar, RebateQuoter, LINK_OPEN_PORTS, linking],
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
 * Root module, assembled per process entry. Every HTTP entry serves the health probe; the `api`
 * entry also serves the /v1 identity routes, the risk module's request signature check, whose
 * device port identity implements, and identity's token check. The union module (adapter registry
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
@Module({})
export class AppModule {
  static forEntry(options: PlatformOptions): DynamicModule {
    // One module object for both imports, so Nest builds the identity module once.
    const identity = options.entry === 'api' ? identityModule() : undefined;
    // One module object per import: Nest builds union and linking once.
    const union =
      options.entry === 'api' || options.entry === 'worker' ? UnionModule.forRoot() : undefined;
    const linking =
      options.entry === 'api'
        ? LinkingModule.forRoot((db, clock) => createContentReader({ db, clock }))
        : undefined;
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(options),
        // Provides the platform AUDIT_PORT globally on every entry (F1-06b).
        AdminModule,
        ...(isHttpEntry(options.entry) ? [HealthModule] : []),
        ...(identity === undefined ? [] : [identity, RiskModule.forRoot({ imports: [identity] })]),
        ...(union === undefined ? [] : [union]),
        ...(options.entry === 'api' && union !== undefined && linking !== undefined
          ? [
              catalogPorts(union, linking),
              CatalogModule.forRoot((db, clock) => createContentReader({ db, clock })),
              linking,
              parsingPorts(),
              // createParsing from parsing's public surface, so the route builds its service
              // through index.ts like any other caller.
              ParsingModule.forRoot((db, clock) => createContentReader({ db, clock }), {
                createParsing,
                localItemRefCipher: createProcessItemRefCipher,
              }),
            ]
          : []),
      ],
      providers: isHttpEntry(options.entry) ? [requestChecks(options)] : [],
    };
  }
}
