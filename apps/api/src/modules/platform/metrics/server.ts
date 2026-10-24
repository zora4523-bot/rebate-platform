// The internal /metrics HTTP server (B1-01zzh): a separate listener, not on the Nest application and
// not in the OpenAPI contract. Only GET /metrics answers (200); every other request is 404.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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

function pathOf(request: IncomingMessage): string {
  const url = request.url ?? '';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

function reply(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(body);
}

export function startMetricsServer(options: MetricsServerOptions): Promise<MetricsServer> {
  const { host, port, registry } = options;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || pathOf(request) !== '/metrics') {
      // The request body (if any) is discarded; nothing else is served.
      request.resume();
      reply(response, 404, 'text/plain; charset=utf-8', 'Not Found\n');
      return;
    }
    registry.render().then(
      (text) => reply(response, 200, registry.contentType, text),
      // A failed collection is a 500 without details; Prometheus marks the target down.
      () => reply(response, 500, 'text/plain; charset=utf-8', 'metrics collection failed\n'),
    );
  });
  // Scrapes are short; idle keep-alive sockets must not hold close() open.
  server.keepAliveTimeout = 5_000;
  return new Promise<MetricsServer>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error === undefined ? done() : fail(error)));
            server.closeAllConnections();
          }),
      });
    });
  });
}
