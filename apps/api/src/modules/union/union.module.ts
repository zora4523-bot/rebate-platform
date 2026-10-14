import { type DynamicModule, Module } from '@nestjs/common';
import { fileURLToPath } from 'node:url';
import {
  APP_CONFIG,
  CLOCK,
  ROOT_LOGGER,
  openPddCredentials,
  type AppConfig,
  type Clock,
  type RootLogger,
} from '../platform/index.ts';
import type { TaobaoPriceWarning } from './domain/taobao-price.ts';
import type { UnionEndpoint } from './domain/types.ts';
import { loadUnionEndpoints } from './infra/endpoints.ts';
import { createUnionHttpTransport } from './infra/http-transport.ts';
import type { PddWarning } from './infra/pdd/response.ts';
import { createUnionRegistry, type UnionRegistry } from './infra/registry.ts';

/** Nest injection tokens provided by `UnionModule`. */
export const UNION_ENDPOINTS = Symbol('UNION_ENDPOINTS');
export const UNION_REGISTRY = Symbol('UNION_REGISTRY');

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

/** Unknown Pinduoduo error codes (B1-04g warn hook) as flat pino fields; no request content. */
function logPddWarning(logger: RootLogger, warning: PddWarning): void {
  logger.warn(
    { event: 'PDD_ERROR_CODE_UNKNOWN', error_code: warning.error_code, method: warning.type },
    'unknown pinduoduo error code',
  );
}

/** The UNION_REGISTRY factory: only the passed config is read, never process.env. */
async function startUnionRegistry(
  endpoints: readonly UnionEndpoint[],
  config: AppConfig,
  clock: Clock,
  logger: RootLogger,
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
  return createUnionRegistry({
    ...options,
    pddLive: {
      credentials,
      transport: createUnionHttpTransport(),
      warn: (warning: PddWarning) => logPddWarning(logger, warning),
    },
  });
}

@Module({})
export class UnionModule {
  static forRoot(directory: string = UNION_ENDPOINTS_DIR): DynamicModule {
    return {
      module: UnionModule,
      providers: [
        {
          provide: UNION_ENDPOINTS,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) => loadUnionEndpoints(directory, config.appEnv),
        },
        {
          provide: UNION_REGISTRY,
          inject: [UNION_ENDPOINTS, APP_CONFIG, CLOCK, ROOT_LOGGER],
          useFactory: startUnionRegistry,
        },
      ],
      exports: [UNION_ENDPOINTS, UNION_REGISTRY],
    };
  }
}
