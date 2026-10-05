/**
 * Internal driver seam: production uses ioredis; rules inject a network-free transport.
 * Readiness checks belong inside connect(); the handle uses call() only for user commands,
 * never for an extra handshake or PING.
 */
export interface RedisTransport {
  connect(): Promise<void>;
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): void;
  /**
   * Optional: registers the callback for an established connection that ended on its own
   * (server restart, network loss). The handle then reconnects before the next command instead
   * of failing it. Not called after quit() or disconnect().
   */
  onConnectionLost?(listener: () => void): void;
}
