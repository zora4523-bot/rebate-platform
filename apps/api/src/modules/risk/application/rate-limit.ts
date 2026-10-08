import type {
  Clock,
  RedisHandle,
  RootLogger,
  TokenPrincipal,
  VerifiedDevice,
} from '../../platform/index.ts';

/** ContentReader is structurally compatible; composition belongs in AppModule. */
export interface RateLimitConfigReader {
  configValue(
    appId: string,
    key: string,
  ): Promise<{ readonly value: unknown; readonly version: number } | null>;
}

export interface RateLimitRule {
  readonly limit: number;
  readonly window_sec: number;
}

/** App/group/dimension policy port, also reusable by the following risk tasks. */
export interface RateLimitThresholdReader {
  groupFor(appId: string, operationId: string): Promise<string | null>;
  rules(
    appId: string,
    group: string,
    dimension: 'user' | 'device' | 'ip',
  ): Promise<readonly RateLimitRule[]>;
}

/** AppModule supplies content's configValue reader; missing/bad/failed reads use defaults. */
export function createRateLimitThresholdReader(
  config: RateLimitConfigReader,
): RateLimitThresholdReader {
  void config;
  throw new Error('NotImplemented: createRateLimitThresholdReader');
}

/** Only verified identity reaches this port; client_ip is Fastify request.ip. */
export interface RateLimitRequest {
  readonly entry: 'api' | 'admin';
  readonly operationId: string;
  readonly app_id: string;
  readonly principal?: TokenPrincipal;
  readonly verifiedDevice?: VerifiedDevice;
  readonly client_ip?: string;
}

export type RateLimitResult =
  { readonly code: 0 } | { readonly code: 42901; readonly retryAfterSec: number };

export interface RateLimitOptions {
  readonly clock: Clock;
  readonly redis: RedisHandle;
  readonly thresholds: RateLimitThresholdReader;
  readonly logger: RootLogger;
}

export interface RateLimitService {
  check(request: RateLimitRequest): Promise<RateLimitResult>;
}

/** B1-03e: reusable three-dimensional Redis buckets, policy lookup and outage alerts. */
export function createRateLimitService(options: RateLimitOptions): RateLimitService {
  void options;
  throw new Error('NotImplemented: createRateLimitService');
}
