import { type DynamicModule, Module } from '@nestjs/common';
import { fileURLToPath } from 'node:url';
import {
  APP_CONFIG,
  CLOCK,
  ROOT_LOGGER,
  type AppConfig,
  type Clock,
  type RootLogger,
} from '../platform/index.ts';
import type { TaobaoPriceWarning } from './domain/taobao-price.ts';
import type { UnionEndpoint } from './domain/types.ts';
import { loadUnionEndpoints } from './infra/endpoints.ts';
import { createUnionRegistry } from './infra/registry.ts';

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
 * TODO(规划/11 §4.5): 配额桶容量与 Redis 令牌桶 — blocked on CAP-TB-12、CAP-JD-12、CAP-PDD-12 配额口径
 * TODO(规划/11 §4.5): 凭据读取 — blocked on 推广位 / siteId
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
          useFactory: (
            endpoints: readonly UnionEndpoint[],
            config: AppConfig,
            clock: Clock,
            logger: RootLogger,
          ) =>
            createUnionRegistry({
              endpoints,
              environment: config.appEnv,
              seed: UNION_DEMO_SEED,
              clock,
              warn: (warning: TaobaoPriceWarning) => logPriceWarning(logger, warning),
            }),
        },
      ],
      exports: [UNION_ENDPOINTS, UNION_REGISTRY],
    };
  }
}
