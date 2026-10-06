import { type DynamicModule, Module } from '@nestjs/common';
import { fileURLToPath } from 'node:url';
import { APP_CONFIG, type AppConfig } from '../platform/index.ts';
import { loadUnionEndpoints } from './infra/endpoints.ts';
import { createUnionRegistry } from './infra/registry.ts';

/** Nest injection tokens provided by `UnionModule`. */
export const UNION_ENDPOINTS = Symbol('UNION_ENDPOINTS');
export const UNION_REGISTRY = Symbol('UNION_REGISTRY');

/** config/union-endpoints/ at the repository root; same depth from src/ and dist/. */
export const UNION_ENDPOINTS_DIR = fileURLToPath(
  new URL('../../../../../config/union-endpoints/', import.meta.url),
);

/**
 * Union (规划/02 §4.1, §6): adapter registry and per-platform endpoint configuration. The
 * endpoints are read once while the entry starts; an invalid set, or a demo / replay endpoint in
 * prod, stops the entry. Governed adapters (createGovernedAdapter) are assembled by the callers
 * that own a quota limiter.
 * TODO(规划/11 §4.5): 配额桶容量与 Redis 令牌桶 — blocked on CAP-TB-12、CAP-JD-12、CAP-PDD-12 配额口径
 * TODO(规划/11 §4.5): 凭据读取 — blocked on 推广位 / siteId
 */
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
        { provide: UNION_REGISTRY, useFactory: () => createUnionRegistry() },
      ],
      exports: [UNION_ENDPOINTS, UNION_REGISTRY],
    };
  }
}
