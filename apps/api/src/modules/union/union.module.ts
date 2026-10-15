import type { DB as Database } from '@couli/db';
import { type DynamicModule, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { fileURLToPath } from 'node:url';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  PDD_QUERY_CUSTOM_PARAMETERS_ENV,
  ROOT_LOGGER,
  UNION_ENDPOINT_OVERRIDE_DIR_ENV,
  openPddCredentials,
  type AppConfig,
  type Clock,
  type RootLogger,
} from '../platform/index.ts';
import type { TaobaoPriceWarning } from './domain/taobao-price.ts';
import { UnionError, type CallCtx, type UnionEndpoint } from './domain/types.ts';
import { loadUnionEndpoints } from './infra/endpoints.ts';
import { createUnionHttpTransport } from './infra/http-transport.ts';
import type { PddQueryIdentity } from './infra/pdd/pdd-adapter.ts';
import type { PddWarning } from './infra/pdd/response.ts';
import { createUnionRegistry, type UnionRegistry } from './infra/registry.ts';
import { readActivePddQueryPid } from './pids/query-reader.ts';

/** Nest injection tokens provided by `UnionModule`. */
export const UNION_ENDPOINTS = Symbol('UNION_ENDPOINTS');
export const UNION_REGISTRY = Symbol('UNION_REGISTRY');
/**
 * B1-04x: the optional database handle the pdd query identity reads union_pids with. A provider
 * of its own (optional DB injection), so the UNION_REGISTRY factory keeps its four dependencies and
 * an entry or isolated test without a database still starts (goods calls are then refused).
 */
export const UNION_QUERY_PID_SOURCE = Symbol('UNION_QUERY_PID_SOURCE');

/** Fixed seed of the demo catalog: the same synthetic items on every start (规划/11 §4.5). */
export const UNION_DEMO_SEED = 'couli-demo';

/** config/union-endpoints/ at the repository root; same depth from src/ and dist/. */
export const UNION_ENDPOINTS_DIR = fileURLToPath(
  new URL('../../../../../config/union-endpoints/', import.meta.url),
);

/**
 * Union (规划/02 §4.1, §6): adapter registry and per-platform endpoint configuration. The
 * endpoints are read once while the entry starts; an invalid set, or a demo / replay endpoint in
 * prod, stops the entry. Platforms configured as mode=demo get the DemoUnionAdapter. Governed adapters (createGovernedAdapter) are assembled by the callers
 * that own a quota limiter.
 * pdd with mode=live (B1-04t): local / test refuse to start, prod refuses until KMS exists, staging
 * reads PDD_CLIENT_SECRET_FILE once here and assembles the real PddUnionAdapter over the HTTPS
 * transport (registry option `pddLive`); a failure stops the entry before it serves anything.
 * TODO(规划/11 §4.5): 配额桶容量与 Redis 令牌桶 — blocked on CAP-TB-12、CAP-JD-12、CAP-PDD-12 配额口径
 * TODO(规划/11 §4.5): jd / taobao 凭据读取 — blocked on 推广位 / siteId
 */
/** BR-PRICE-01 / BR-PRICE-02 alarms as flat pino fields: the code, and for an unknown name only
 * the name (no item data).
 * TODO(规划/11 §9.2): 名称清单与 unknown_promo、basis 开关的配置接线 — blocked on followups F-36
 */
function logPriceWarning(logger: RootLogger, warning: TaobaoPriceWarning): void {
  if (warning.code === 'PRICE_PROMO_UNKNOWN') {
    logger.warn({ event: warning.code, promotion_title: warning.title }, 'unknown promotion name');
  } else {
    logger.warn({ event: warning.code }, 'taobao price detail does not reconcile');
  }
}

/**
 * The Pinduoduo warn hook as flat pino fields; no request content, item data or amount. A warning
 * with an `event` (B1-04u: PRICE_ANOMALY from the goods mapping) is logged as that event; one
 * without is an unknown error code (B1-04g).
 */
function logPddWarning(logger: RootLogger, warning: PddWarning): void {
  if (warning.event !== undefined) {
    logger.warn({ event: warning.event, method: warning.type }, 'pinduoduo goods price anomaly');
    return;
  }
  logger.warn(
    { event: 'PDD_ERROR_CODE_UNKNOWN', error_code: warning.error_code, method: warning.type },
    'unknown pinduoduo error code',
  );
}

/** Filled by the UNION_QUERY_PID_SOURCE provider; `db` stays undefined without a database. */
interface QueryPidSource {
  db: Kysely<Database> | undefined;
}

function queryRefused(reason: string): UnionError {
  return new UnionError('upstream_rejected', `pdd query identity: ${reason}`, 'pdd');
}

/**
 * The pdd goods ports' query identity (B1-04u D-u2, B1-04x): per call, the active pdd / query PID
 * of ctx.appId (read again every call; no other scene or app is ever used, BR-ATTR-08) and the
 * configured custom_parameters verbatim. Reads only ctx.appId. Any gap is `upstream_rejected`.
 */
function pddQueryIdentity(
  source: QueryPidSource,
  customParameters: string | null | undefined,
): (ctx: CallCtx) => Promise<PddQueryIdentity> {
  return async (ctx) => {
    if (customParameters == null || customParameters === '') {
      throw queryRefused(`${PDD_QUERY_CUSTOM_PARAMETERS_ENV} is not configured`);
    }
    const db = source.db;
    if (db === undefined) throw queryRefused('no database to read the query PID from');
    const pid = await readActivePddQueryPid(db, ctx.appId);
    if (pid === null) throw queryRefused('no active query PID for this app');
    return { pid, customParameters };
  };
}

/**
 * The UNION_REGISTRY factory: only the passed config is read, never process.env. pdd live without
 * PDD_QUERY_CUSTOM_PARAMETERS still starts and warns once with only the variable name.
 */
async function startUnionRegistry(
  endpoints: readonly UnionEndpoint[],
  config: AppConfig,
  clock: Clock,
  logger: RootLogger,
  source: QueryPidSource,
): Promise<UnionRegistry> {
  const options = {
    endpoints,
    environment: config.appEnv,
    seed: UNION_DEMO_SEED,
    clock,
    warn: (warning: TaobaoPriceWarning) => logPriceWarning(logger, warning),
  };
  const pdd = endpoints.find((endpoint) => endpoint.platform === 'pdd');
  if (pdd?.mode !== 'live') return createUnionRegistry(options);
  // Refusals (environment, missing or unreadable credentials) throw PddStartupError: fixed text.
  const credentials = await openPddCredentials(config.appEnv, config.pdd);
  const customParameters = config.pddQueryCustomParameters;
  if (customParameters == null || customParameters === '') {
    logger.warn(PDD_QUERY_CUSTOM_PARAMETERS_ENV);
  }
  return createUnionRegistry({
    ...options,
    pddLive: {
      credentials,
      transport: createUnionHttpTransport(),
      warn: (warning: PddWarning) => logPddWarning(logger, warning),
      queryIdentity: pddQueryIdentity(source, customParameters),
    },
  });
}

/**
 * The UNION_ENDPOINTS factory (B1-04y): with UNION_ENDPOINT_OVERRIDE_DIR (staging only, validated
 * by loadConfig) the three endpoint files are read from that mounted directory, with the same
 * validation; a missing or invalid file there stops the entry (no fallback to the packaged
 * directory). Without it the module's directory is read. Each call reads its own config; nothing
 * is cached between configs.
 */
function startUnionEndpoints(
  directory: string,
  config: AppConfig,
): Promise<readonly UnionEndpoint[]> {
  const override = config.unionEndpointOverrideDir;
  if (override == null || override === '') return loadUnionEndpoints(directory, config.appEnv);
  if (config.appEnv !== 'staging') {
    // loadConfig refuses this already; a hand-built config must not reach another environment.
    return Promise.reject(
      new UnionError(
        'invalid_endpoint',
        `${UNION_ENDPOINT_OVERRIDE_DIR_ENV} is only accepted when APP_ENV=staging`,
      ),
    );
  }
  return loadUnionEndpoints(override, config.appEnv);
}

@Module({})
export class UnionModule {
  static forRoot(directory: string = UNION_ENDPOINTS_DIR): DynamicModule {
    // One source per module instance: the registry's query identity reads it lazily, per call.
    const source: QueryPidSource = { db: undefined };
    return {
      module: UnionModule,
      providers: [
        {
          provide: UNION_ENDPOINTS,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) => startUnionEndpoints(directory, config),
        },
        {
          provide: UNION_REGISTRY,
          inject: [UNION_ENDPOINTS, APP_CONFIG, CLOCK, ROOT_LOGGER],
          useFactory: (
            endpoints: readonly UnionEndpoint[],
            config: AppConfig,
            clock: Clock,
            logger: RootLogger,
          ) => startUnionRegistry(endpoints, config, clock, logger, source),
        },
        {
          provide: UNION_QUERY_PID_SOURCE,
          inject: [{ token: DB, optional: true }],
          useFactory: (db?: Kysely<Database>) => {
            source.db = db ?? undefined;
            return source;
          },
        },
      ],
      exports: [UNION_ENDPOINTS, UNION_REGISTRY],
    };
  }
}
