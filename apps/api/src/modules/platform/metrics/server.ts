// The internal /metrics HTTP server (B1-01zzh): a separate listener, not on the Nest application and
// not in the OpenAPI contract. Only GET /metrics answers (200); every other request is 404.
import type { MetricsRegistry } from './registry.ts';

export interface MetricsServerOptions {
  readonly host: string;
  /** 0 picks a free port (tests); configuration only accepts 1024–65535. */
  readonly port: number;
  readonly registry: MetricsRegistry;
}

export interface MetricsServer {
  /** The port actually listened on. */
  readonly port: number;
  close(): Promise<void>;
}

export function startMetricsServer(options: MetricsServerOptions): Promise<MetricsServer> {
  void options;
  throw new Error('NotImplemented: startMetricsServer');
}
